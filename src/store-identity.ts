// Identity lifecycle: init, profile updates, handle, card/handle-claim/friend-
// profile building, doctor, import/export, deregister, and the local-data
// export/review used by the reader.
//
// Extracted from EdgeBookStore (2026-06-10 size-compliance refactor); each
// public function is called by a same-named one-line delegate method on
// EdgeBookStore. Invariants:
//   - profile updates and handle changes never rotate keys, so the agent_id
//     (DID) survives; every identity write re-signs and rewrites the card;
//   - the identity file carries the private key and is written 0o600;
//   - deregister follows the R7 cascade: deprecate Class 1, terminate open
//     Class 2, RETAIN Class 3 + Class 4.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { AgentCard, Answer, EphemeralPost, FieldVisibility, FriendProfile, IdentityProfile, LocalIdentity, Signal, SocialLink, EdgeBookConfig } from "./types.ts";
import { stableIdFromPublicKey, canonicalize, signPayload } from "./crypto.ts";
import { now, ensureHome, readJson, writeJson } from "./fs-json.ts";
import { isValidHandle } from "./handles.ts";
import { defaultProfile, projectProfileFields } from "./profile.ts";
import { loadCard } from "./cards.ts";
import { ANSWERS_FILE, CARD_FILE, CONFIG_FILE, CONTACTS_FILE, EPHEMERAL_FILE, GRANTS_FILE, IDENTITY_FILE, SEEN_MESSAGES_FILE, SIGNALS_FILE } from "./store-files.ts";

export async function init(store: EdgeBookStore, input: { handle?: string; displayName?: string; ownerLabel?: string; shareOwnerLabel?: boolean; cardUrl?: string; directUrl?: string; relayUrl?: string } = {}): Promise<LocalIdentity> {
  await ensureHome(store.home);
  const existing = await readJson<LocalIdentity | null>(store.file(IDENTITY_FILE), null);
  if (existing) {
    await store.updateConfig({ direct_url: input.directUrl, relay_url: input.relayUrl });
    return existing;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const public_key_pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const private_key_pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const identity: LocalIdentity = {
    agent_id: stableIdFromPublicKey(public_key_pem),
    handle: input.handle || "agent.openclaw.local",
    display_name: input.displayName || "",
    owner_label: input.ownerLabel || "",
    ...(input.shareOwnerLabel ? { share_owner_label: true } : {}),
    public_key_pem,
    private_key_pem,
    created_at: now(),
    updated_at: now()
  };
  await writeJson(store.file(IDENTITY_FILE), identity, 0o600);
  await writeJson(store.file(CONTACTS_FILE), {});
  await writeJson(store.file(GRANTS_FILE), {});
  await writeJson(store.file(SEEN_MESSAGES_FILE), []);
  await store.updateConfig({ direct_url: input.directUrl, relay_url: input.relayUrl });
  await store.audit("identity.init", identity.agent_id, { handle: identity.handle });
  await store.writeCard(input.cardUrl);
  return identity;
}

// Update profile fields on an existing identity without rotating keys, so the
// agent_id survives. display_name is the agent's own name (public, on the card).
// name/bio/location/socials are the human profile, governed by per-field
// visibility (default "friends"). Legacy ownerLabel/shareOwnerLabel map onto
// profile.name + visibility.name for back-compat.
export async function setProfile(store: EdgeBookStore, input: {
  displayName?: string;
  ownerLabel?: string;
  shareOwnerLabel?: boolean;
  name?: string;
  bio?: string;
  location?: string;
  socials?: SocialLink[];
  visibility?: Record<string, FieldVisibility>;
}): Promise<LocalIdentity> {
  const identity = await store.identity();
  const profile: IdentityProfile = { ...defaultProfile(identity) };
  profile.visibility = { ...(profile.visibility ?? {}) };

  if (input.displayName !== undefined && input.displayName !== "") identity.display_name = input.displayName;

  // Legacy shims: ownerLabel -> profile.name; shareOwnerLabel -> name visibility.
  if (input.ownerLabel !== undefined) {
    identity.owner_label = input.ownerLabel;
    profile.name = input.ownerLabel || undefined;
  }
  if (input.shareOwnerLabel !== undefined) {
    identity.share_owner_label = input.shareOwnerLabel;
    profile.visibility.name = input.shareOwnerLabel ? "public" : "friends";
  }

  if (input.name !== undefined) profile.name = input.name || undefined;
  if (input.bio !== undefined) profile.bio = input.bio || undefined;
  if (input.location !== undefined) profile.location = input.location || undefined;
  if (input.socials !== undefined) {
    const RESERVED = new Set(["name", "bio", "location"]);
    for (const s of input.socials) {
      if (RESERVED.has(s.label.toLowerCase())) {
        throw new EdgeBookError(
          "reserved_social_label",
          `Social label '${s.label}' is reserved; choose another (e.g. telegram, twitter)`,
        );
      }
    }
    profile.socials = input.socials;
  }
  if (input.visibility) profile.visibility = { ...profile.visibility, ...input.visibility };

  profile.profile_version = (profile.profile_version ?? 1) + 1;
  identity.profile = profile;
  identity.updated_at = now();
  await writeJson(store.file(IDENTITY_FILE), identity, 0o600);
  await store.writeCard();
  await store.audit("identity.update", identity.agent_id, { display_name: identity.display_name, profile_version: profile.profile_version });
  return identity;
}

// Set a user-chosen unique handle. Re-signs the card; does NOT rotate keys.
export async function setHandle(store: EdgeBookStore, handle: string): Promise<LocalIdentity> {
  if (!isValidHandle(handle)) {
    throw new EdgeBookError("invalid_handle", `invalid_handle: must be 3-30 chars [a-z0-9-], not reserved: ${handle}`);
  }
  const identity = await store.identity();
  identity.handle = handle;
  identity.updated_at = now();
  await writeJson(store.file(IDENTITY_FILE), identity, 0o600);
  await store.writeCard();
  await store.audit("identity.set_handle", identity.agent_id, { handle });
  return identity;
}

// Portable identity bundle (the DID keypair + chosen handle). Carry to a new
// device → same DID → relay handle keeps resolving to you (spec-096).
export async function exportIdentity(store: EdgeBookStore): Promise<{ schema: "edge-book-identity-export/0.1"; identity: LocalIdentity }> {
  return { schema: "edge-book-identity-export/0.1", identity: await store.identity() };
}

export async function importIdentity(store: EdgeBookStore, bundle: { identity: LocalIdentity }, opts: { force?: boolean } = {}): Promise<LocalIdentity> {
  await ensureHome(store.home);
  const existing = await readJson<LocalIdentity | null>(store.file(IDENTITY_FILE), null);
  if (existing && !opts.force) throw new EdgeBookError("identity_exists", `identity_exists: an identity already exists at ${store.home} (use --force to overwrite)`);
  const id = bundle.identity;
  if (!id?.public_key_pem || id.agent_id !== stableIdFromPublicKey(id.public_key_pem)) {
    throw new EdgeBookError("invalid_import", "Bundle agent_id does not match its public key");
  }
  await writeJson(store.file(IDENTITY_FILE), id, 0o600);
  if (!(await readJson<unknown | null>(store.file(CONTACTS_FILE), null))) await writeJson(store.file(CONTACTS_FILE), {});
  if (!(await readJson<unknown | null>(store.file(GRANTS_FILE), null))) await writeJson(store.file(GRANTS_FILE), {});
  if (!(await readJson<unknown | null>(store.file(SEEN_MESSAGES_FILE), null))) await writeJson(store.file(SEEN_MESSAGES_FILE), []);
  await store.writeCard();
  await store.audit("identity.import", id.agent_id, { handle: id.handle });
  return id;
}

export async function updateConfig(store: EdgeBookStore, input: EdgeBookConfig): Promise<EdgeBookConfig> {
  const current = await store.config();
  const next: EdgeBookConfig = { ...current };
  if (input.direct_url !== undefined) next.direct_url = input.direct_url;
  if (input.relay_url !== undefined) next.relay_url = input.relay_url;
  if (input.notify_on_friend_request !== undefined) next.notify_on_friend_request = input.notify_on_friend_request;
  if (input.notify_cmd !== undefined) next.notify_cmd = input.notify_cmd;
  if (input.notify_types !== undefined) next.notify_types = input.notify_types;
  if (input.open_friend_requests !== undefined) next.open_friend_requests = input.open_friend_requests;
  if (input.inbound_max_per_peer !== undefined) next.inbound_max_per_peer = input.inbound_max_per_peer;
  if (input.inbound_max_global !== undefined) next.inbound_max_global = input.inbound_max_global;
  if (input.inbound_window_ms !== undefined) next.inbound_window_ms = input.inbound_window_ms;
  if (input.handle_nudge_at !== undefined) next.handle_nudge_at = input.handle_nudge_at;
  if (input.greeter_mode !== undefined) next.greeter_mode = input.greeter_mode;
  if (input.greeter_welcome_object_id !== undefined) next.greeter_welcome_object_id = input.greeter_welcome_object_id;
  await writeJson(store.file(CONFIG_FILE), next);
  return next;
}

export async function buildCard(store: EdgeBookStore, cardUrl?: string): Promise<AgentCard> {
  const identity = await store.identity();
  const config = await store.config();
  const transports: AgentCard["transports"] = [{ mode: "local", endpoint: store.home }];
  if (config.direct_url) transports.push({ mode: "direct", endpoint: config.direct_url });
  if (config.relay_url) transports.push({ mode: "relay", endpoint: config.relay_url });
  const caps = Object.values(await store.capabilities())
    .map((c) => ({ name: c.name, version: c.version, summary: c.summary, status: c.status }));
  const prof = defaultProfile(identity);
  const publicFields = projectProfileFields(prof, (v) => v === "public");
  const publicProfile: NonNullable<AgentCard["public_profile"]> = { ...publicFields };
  const publicName = publicFields.name;
  const unsigned: Omit<AgentCard, "card_hash" | "signature"> = {
    schema: "openclaw-agent-card/0.1",
    agent_id: identity.agent_id,
    handle: identity.handle,
    display_name: identity.display_name,
    ...(publicName ? { owner_label: publicName } : {}),
    ...(Object.keys(publicProfile).length ? { public_profile: publicProfile } : {}),
    card_url: cardUrl || `file://${store.file(CARD_FILE)}`,
    card_version: 1,
    public_keys: [{ id: `${identity.agent_id}#main`, type: "ed25519", public_key_pem: identity.public_key_pem }],
    capabilities: ["friend_request", "friend_gated_message", "feed_read_friends"],
    ...(caps.length ? { advertised_capabilities: caps } : {}),
    transports,
    refresh_after: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  const card_hash = crypto.createHash("sha256").update(canonicalize(unsigned)).digest("base64url");
  const withHash = { ...unsigned, card_hash };
  return { ...withHash, signature: signPayload(withHash, identity.private_key_pem) };
}

export async function writeCard(store: EdgeBookStore, cardUrl?: string): Promise<AgentCard> {
  const card = await store.buildCard(cardUrl);
  await writeJson(store.file(CARD_FILE), card);
  return card;
}

// Build a signed handle claim for the relay registry (spec-096). The relay
// verifies claim_sig + the card against the identity key before binding.
export async function buildHandleClaim(store: EdgeBookStore): Promise<{ handle: string; agent_did: string; card: AgentCard; claimed_at: number; claim_sig: string }> {
  const identity = await store.identity();
  if (!isValidHandle(identity.handle)) {
    throw new EdgeBookError("invalid_handle", `invalid_handle: set a handle first (current: ${identity.handle})`);
  }
  const card = await loadCard(store.file(CARD_FILE)); // current signed card
  const claimed_at = Date.now();
  const claim_sig = signPayload({ handle: identity.handle, agent_did: identity.agent_id, claimed_at }, identity.private_key_pem);
  return { handle: identity.handle, agent_did: identity.agent_id, card, claimed_at, claim_sig };
}

// The friend-only profile: every field whose visibility resolves to "friends"
// or "public". Signed; shared only with confirmed friends.
export async function buildFriendProfile(store: EdgeBookStore): Promise<FriendProfile> {
  const identity = await store.identity();
  const profile = defaultProfile(identity);
  const friendFields = projectProfileFields(profile, (v) => v !== "off");
  const unsigned: Omit<FriendProfile, "signature"> = {
    schema: "openclaw-friend-profile/0.1",
    agent_id: identity.agent_id,
    profile_version: profile.profile_version ?? 1,
    ...friendFields,
    issued_at: now(),
  };
  return { ...unsigned, signature: signPayload(unsigned, identity.private_key_pem) };
}

export async function doctor(store: EdgeBookStore): Promise<Record<string, unknown>> {
  const identity = await readJson<LocalIdentity | null>(store.file(IDENTITY_FILE), null);
  const config = await store.config();
  const checks: Record<string, unknown> = {
    home: store.home,
    initialized: Boolean(identity),
    config,
    files: {}
  };
  const requiredFiles = [IDENTITY_FILE, CONTACTS_FILE, GRANTS_FILE, SEEN_MESSAGES_FILE, CARD_FILE];
  const files: Record<string, unknown> = {};
  for (const name of requiredFiles) {
    try {
      const stat = await fs.stat(store.file(name));
      files[name] = {
        exists: true,
        mode: `0${(stat.mode & 0o777).toString(8)}`
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files[name] = { exists: false };
      } else {
        throw error;
      }
    }
  }
  checks.files = files;
  let cardValid = false;
  try {
    const card = await loadCard(store.file(CARD_FILE));
    cardValid = Boolean(identity && card.agent_id === identity.agent_id);
  } catch {
    cardValid = false;
  }
  const identityMode = (files[IDENTITY_FILE] as { mode?: string }).mode;
  const privateKeyModeOk = process.platform === "win32" || identityMode === "0600";
  checks.card_valid = cardValid;
  checks.private_key_mode_ok = privateKeyModeOk;
  checks.pass = Boolean(identity) && cardValid && privateKeyModeOk;
  return checks;
}

// R7 cascade: deprecate Class 1, terminate open Class 2, RETAIN Class 3 + Class 4.
export async function deregister(store: EdgeBookStore): Promise<void> {
  const identity = await store.identity();
  const caps = await store.capabilities();
  for (const id of Object.keys(caps)) {
    const cap = caps[id]!; // key comes from Object.keys(caps) — value is present
    if (cap.status === "active") {
      cap.status = "deprecated";
      cap.updated_at = now();
      const { signature: _sig, ...rest } = cap;
      cap.signature = signPayload(rest, identity.private_key_pem);
    }
  }
  await store.saveCapabilities(caps);
  const sigs = await readJson<Record<string, Signal>>(store.file(SIGNALS_FILE), {});
  for (const id of Object.keys(sigs)) {
    const sig = sigs[id]!; // key comes from Object.keys(sigs) — value is present
    if (sig.lifecycle !== "expired") sig.lifecycle = "expired";
  }
  await store.saveSignals(sigs);
  const eph = await readJson<Record<string, EphemeralPost>>(store.file(EPHEMERAL_FILE), {});
  for (const id of Object.keys(eph)) {
    const post = eph[id]!; // key comes from Object.keys(eph) — value is present
    const lc = post.lifecycle;
    if (lc === "expired" || lc === "cancelled" || lc === "tombstoned") continue;
    const t = post.post_type;
    post.lifecycle = (t === "query" || t === "delegation_request") ? "cancelled" : "expired";
  }
  await store.saveEphemeral(eph);
  const ans = await readJson<Record<string, Answer>>(store.file(ANSWERS_FILE), {});
  for (const id of Object.keys(ans)) {
    const answer = ans[id]!; // key comes from Object.keys(ans) — value is present
    if (answer.lifecycle !== "tombstoned") answer.lifecycle = "tombstoned";
  }
  await store.saveAnswers(ans);
  // Endorsements (Class 3 evidence) + Attestations (Class 4) remain retained (untouched).
  await store.audit("agent.deregister", (await store.identity()).agent_id, {});
}

export async function reviewLocalDataImport(store: EdgeBookStore, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const objectCount = (key: string): number => {
    const value = data[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
  };
  const audit = Array.isArray(data.audit) ? data.audit.length : 0;
  return {
    review_only: true,
    activates_remote_endpoints: false,
    counts: {
      contacts: objectCount("contacts"),
      grants: objectCount("grants"),
      sessions: objectCount("sessions"),
      posts: objectCount("posts"),
      feed_items: objectCount("feed_items"),
      approvals: objectCount("approvals"),
      contact_mutes: objectCount("contact_mutes"),
      audit
    }
  };
}

export async function exportLocalData(store: EdgeBookStore): Promise<Record<string, unknown>> {
  return {
    identity: await store.identity(),
    contacts: await store.contacts(),
    grants: await store.grants(),
    sessions: await store.sessions(),
    posts: await store.posts(),
    feed_items: await store.feedItems(),
    approvals: await store.approvals(),
    contact_mutes: await store.contactMutes(),
    audit: await store.auditEvents()
  };
}
