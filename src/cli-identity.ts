// Identity & profile CLI commands (split from cli.ts): init, handle,
// identity export/import, profile show/set/visibility/broadcast, doctor,
// card show/export/invite. Command names/flags are FROZEN (npm surface);
// handleCli in cli.ts stays the only dispatch entry and calls this handler
// in dispatch order. Returns null when the command is not one of its own.
import fs from "node:fs/promises";
import path from "node:path";
import { deliverToPeer, deliverViaMailboxRecorded, parseHost, relayBaseFromHost, requireArg, takeBoolFlag, takeFlag, takeRepeatedKV } from "./cli-shared.ts";
import type { CliContext, CliResult } from "./cli-shared.ts";
import { buildDoctorReport, renderDoctorText } from "./doctor.ts";
import { runDoctorSend } from "./doctor-send.ts";
import { EdgeBookError, EdgeBookStore, defaultProfile, slugifyHandle } from "./edge-book.ts";
import type { FieldVisibility } from "./edge-book.ts";
import { buildOnboardingNote, recordInviteCandidate, seedGreeterCandidate } from "./onboarding.ts";
import type { OnboardingNoteOptions } from "./onboarding.ts";

export async function handleIdentityCli(command: string, args: string[], ctx: CliContext, home: string | undefined, store: EdgeBookStore): Promise<CliResult | null> {
  if (command === "init") {
    const rawHandle = takeFlag(args, "--handle");
    const handle = rawHandle !== undefined ? slugifyHandle(rawHandle) : undefined;
    const displayName = takeFlag(args, "--name");
    const ownerLabel = takeFlag(args, "--owner");
    const shareOwner = takeBoolFlag(args, "--share-owner");
    const directUrl = takeFlag(args, "--direct-url");
    const relayUrl = takeFlag(args, "--relay-url");
    const fromInvite = takeFlag(args, "--from-invite");
    // spec-132: greeter candidate opt-outs + relay base for the handle URL.
    // EDGE_BOOK_RELAY_BASE wins; otherwise derive https origin from the dialout host.
    const noGreeter = takeBoolFlag(args, "--no-greeter") || process.env.EDGE_BOOK_NO_GREETER === "1";
    const relayBase = process.env.EDGE_BOOK_RELAY_BASE || relayBaseFromHost(parseHost(args, ctx));
    const identity = await store.init({ handle, displayName, ownerLabel, shareOwnerLabel: shareOwner, directUrl, relayUrl });
    // spec-129: a bad invite must never block identity creation — soft-catch.
    const onboardingOpts: OnboardingNoteOptions = {};
    let onboardingJson: Record<string, string> | undefined;
    if (fromInvite !== undefined) {
      try {
        const invite = await recordInviteCandidate(store, fromInvite);
        onboardingOpts.invite = invite;
        onboardingJson = { invite_candidate_id: invite.candidateId, invite_display_name: invite.displayName };
      } catch (error) {
        const code = error instanceof EdgeBookError ? error.code : "bad_invite";
        onboardingOpts.inviteError = code;
        onboardingJson = { invite_error: code };
      }
    }
    // spec-132: seed the greeter candidate so a cold-path init never lands in
    // an empty room. Coexists with any --from-invite candidate. Local write
    // only — zero network at init.
    if (!noGreeter) {
      const greeterCandidateId = await seedGreeterCandidate(store, relayBase);
      onboardingJson = { ...(onboardingJson ?? {}), greeter_candidate_id: greeterCandidateId };
    }
    const note =
      `Initialized ${identity.agent_id} at ${store.home}\n\n` +
      `Two-tier profile:\n` +
      `  • agent name (display_name): "${identity.display_name}" — always public on your card.\n` +
      `  • your profile (name, bio, location, socials): default visible to FRIENDS only, hidden on the public card.\n` +
      `Set it: edge-book profile set --name "<you>" --bio "..." --social telegram=@you\n` +
      `Tune visibility: edge-book profile visibility bio=off telegram=public name=public\n\n` +
      `Notifications (so inbound friend requests & messages reach you in real time):\n` +
      `  Set a host notify command — Edge Book stays transport-free and pipes the message to it.\n` +
      `  edge-book dialout --notify-cmd "<deliver-to-your-channel>"\n` +
      `  (or set EDGE_BOOK_NOTIFY_CMD, or config.notify_cmd). Without it, inbound items are silent\n` +
      `  until a fallback poller surfaces them.\n\n` +
      buildOnboardingNote(onboardingOpts);
    return { text: note, json: onboardingJson ? { ...identity, onboarding: onboardingJson } : identity };
  }

  if (command === "handle") {
    const action = args.shift();
    if (action === "set") {
      const slug = requireArg(args.shift(), "handle set <slug>");
      const hidden = takeBoolFlag(args, "--hidden");
      const id = await store.setHandle(slugifyHandle(slug), { discoverable: hidden ? false : undefined });
      const hiddenNote = hidden ? " (hidden from /directory)" : "";
      return { text: `Handle set: ${id.handle} (${id.agent_id})${hiddenNote}`, json: { handle: id.handle, agent_id: id.agent_id, discoverable: !hidden } };
    }
    if (action === "show") {
      const id = await store.identity();
      return { text: `${id.handle}\n${id.agent_id}`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("unknown_action", `Unknown handle action: ${action} (use "set" or "show")`);
  }

  if (command === "identity") {
    const action = args.shift();
    if (action === "export") {
      const bundle = await store.exportIdentity();
      const p = takeFlag(args, "--path");
      if (p) {
        // The bundle carries the private key — write it owner-only (0o600).
        const target = path.resolve(p);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return { text: `Identity exported → ${target}`, json: { path: target } };
      }
      return { text: JSON.stringify(bundle), json: bundle };
    }
    if (action === "import") {
      const source = requireArg(args.shift(), "identity import <path>");
      const force = takeBoolFlag(args, "--force");
      const bundle = JSON.parse(await fs.readFile(path.resolve(source), "utf8"));
      const id = await store.importIdentity(bundle, { force });
      return { text: `Identity imported: ${id.handle} (${id.agent_id})`, json: { handle: id.handle, agent_id: id.agent_id } };
    }
    throw new EdgeBookError("unknown_action", `Unknown identity action: ${action} (use "export" or "import")`);
  }

  if (command === "profile") {
    const action = args.shift() || "show";
    if (action === "show") {
      const id = await store.identity();
      const p = defaultProfile(id);
      return {
        text:
          `display_name: ${id.display_name}\n` +
          `name: ${p.name || "(unset)"}\n` +
          `bio: ${p.bio || "(unset)"}\n` +
          `location: ${p.location || "(unset)"}\n` +
          `socials: ${(p.socials ?? []).map((s) => `${s.label}=${s.value}`).join(", ") || "(none)"}\n` +
          `visibility: ${JSON.stringify(p.visibility ?? {})}`,
        json: { agent_id: id.agent_id, display_name: id.display_name, name: p.name, bio: p.bio, location: p.location, socials: p.socials ?? [], visibility: p.visibility ?? {} },
      };
    }
    if (action === "set") {
      const displayName = takeFlag(args, "--agent-name");
      const name = takeFlag(args, "--name");
      const bio = takeFlag(args, "--bio");
      const location = takeFlag(args, "--location");
      const socialsKV = takeRepeatedKV(args, "--social");
      // Legacy aliases kept working.
      const ownerLabel = takeFlag(args, "--owner");
      const shareOwner = takeBoolFlag(args, "--share-owner");
      const noShareOwner = takeBoolFlag(args, "--no-share-owner");
      const shareOwnerLabel = shareOwner ? true : (noShareOwner ? false : undefined);
      // Guard: at least one meaningful flag must be present.
      if (
        displayName === undefined &&
        name === undefined &&
        bio === undefined &&
        location === undefined &&
        socialsKV.length === 0 &&
        ownerLabel === undefined &&
        shareOwnerLabel === undefined
      ) {
        throw new EdgeBookError(
          "missing_arg",
          "profile set needs at least one of --name/--agent-name/--bio/--location/--social/--owner/--share-owner",
        );
      }
      const id = await store.setProfile({
        displayName,
        name,
        bio,
        location,
        socials: socialsKV.length ? socialsKV : undefined,
        ownerLabel,
        shareOwnerLabel,
      });
      const p = defaultProfile(id);
      return { text: `Updated profile (v${p.profile_version}): name=${p.name || "(unset)"}`, json: { agent_id: id.agent_id, name: p.name, profile_version: p.profile_version } };
    }
    if (action === "visibility") {
      const pairs = args.splice(0).map((tok) => {
        const eq = tok.indexOf("=");
        if (eq === -1) throw new EdgeBookError("bad_visibility", `expected field=friends|public|off, got "${tok}"`);
        const field = tok.slice(0, eq);
        const vis = tok.slice(eq + 1) as FieldVisibility;
        if (!["friends", "public", "off"].includes(vis)) throw new EdgeBookError("bad_visibility", `bad visibility "${vis}" for ${field}`);
        return [field, vis] as const;
      });
      if (!pairs.length) throw new EdgeBookError("missing_arg", "profile visibility needs at least one field=friends|public|off");
      // Validate keys: must be a known field, "*", or an existing social label.
      const KNOWN_FIELDS = new Set(["name", "bio", "location", "*"]);
      const currentId = await store.identity();
      const currentProfile = defaultProfile(currentId);
      const socialLabels = new Set((currentProfile.socials ?? []).map((s) => s.label));
      for (const [field] of pairs) {
        if (!KNOWN_FIELDS.has(field) && !socialLabels.has(field)) {
          const known = [...KNOWN_FIELDS, ...socialLabels].join(", ");
          throw new EdgeBookError(
            "unknown_visibility_field",
            `Unknown profile field/social '${field}'; known: name, bio, location, *, plus your social labels${socialLabels.size ? ` (${[...socialLabels].join(", ")})` : ""}`,
          );
        }
      }
      const id = await store.setProfile({ visibility: Object.fromEntries(pairs) });
      const p = defaultProfile(id);
      return { text: `Updated visibility: ${JSON.stringify(p.visibility ?? {})}`, json: { visibility: p.visibility ?? {} } };
    }
    if (action === "broadcast") {
      const deliver = takeBoolFlag(args, "--deliver");
      const envelopes = await store.broadcastProfileEnvelopes();
      if (deliver) {
        const hostUrl = parseHost(args, ctx);
        for (const envelope of envelopes) {
          try {
            await deliverToPeer(store, envelope, envelope.to_agent_id);
          } catch (error) {
            if (!(error instanceof EdgeBookError) || error.code !== "no_route") throw error;
            // spec-097 §C.1: every successful --deliver appends to the outbox
            // ledger. The broadcast prints an aggregate count, so the per-send
            // wording is discarded — recording (incl. recipient_live) is what
            // matters here.
            await deliverViaMailboxRecorded(envelope, { home, host: hostUrl, socketFactory: ctx.socketFactory },
              (id) => `Delivered profile_share (host id ${id})`);
          }
        }
        return { text: `Broadcast profile to ${envelopes.length} friend(s)`, json: { count: envelopes.length } };
      }
      return { text: `Built ${envelopes.length} profile_share envelope(s)`, json: { envelopes } };
    }
    throw new EdgeBookError("unknown_action", `Unknown profile action: ${action} (use "show", "set", "visibility", or "broadcast")`);
  }

  if (command === "doctor") {
    // Full diagnostic bundle (spec-133): human text by default, --json for the
    // machine shape. Safe to paste publicly — see src/doctor.ts header.
    const asJson = takeBoolFlag(args, "--json");
    const send = takeBoolFlag(args, "--send");
    const host = parseHost(args, ctx);
    if (send) {
      // spec-134: consented delivery to the operator support mailbox.
      return runDoctorSend(store, home, {
        host,
        yes: takeBoolFlag(args, "--yes"),
        to: takeFlag(args, "--to"),
        note: takeFlag(args, "--note"),
        socketFactory: ctx.socketFactory,
      });
    }
    const report = await buildDoctorReport(store, { host });
    return { text: asJson ? JSON.stringify(report, null, 2) : renderDoctorText(report), json: report };
  }

  if (command === "card") {
    const action = args.shift() || "show";
    if (action === "show") {
      const card = await store.writeCard();
      return { text: JSON.stringify(card, null, 2), json: card };
    }
    if (action === "export") {
      const target = requireArg(takeFlag(args, "--path"), "--path");
      const card = await store.writeCard();
      await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
      await fs.writeFile(path.resolve(target), `${JSON.stringify(card, null, 2)}\n`, "utf8");
      return { text: `Exported Agent Card to ${path.resolve(target)}`, json: card };
    }
    if (action === "invite") {
      // "Add me" link. Default text output is the tappable deeplink URL (spec-095);
      // --raw emits the bare edgebook:invite: blob for agents that consume it directly.
      const ttlMsStr = takeFlag(args, "--ttl-ms");
      const usesStr = takeFlag(args, "--uses");
      const raw = takeBoolFlag(args, "--raw");
      const ttlMs = ttlMsStr ? Number(ttlMsStr) : undefined;
      const maxUses = usesStr ? Number(usesStr) : undefined;
      const card = await store.writeCard();
      const blob = `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
      const origin = card.card_url ? new URL(card.card_url).origin : relayBaseFromHost(parseHost(args, ctx));
      const deeplink_url = `${origin}/add#i=${encodeURIComponent(blob)}`;
      if (ttlMs !== undefined || maxUses !== undefined) {
        const invite = await store.mintInviteCode({ ttlMs, maxUses });
        const invite_url = `${blob}#code=${invite.code}`;
        return { text: raw ? invite_url : deeplink_url, json: { invite_url, deeplink_url, agent_id: card.agent_id, invite_code: invite.code } };
      }
      return { text: raw ? blob : deeplink_url, json: { invite_url: blob, deeplink_url, agent_id: card.agent_id } };
    }
  }

  return null;
}
