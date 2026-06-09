// Two-agent smoke framework (ea-openclaw-031). Creates independent
// EdgeBookStore agents on disk and drives the full interaction surface —
// resolve, friend handshake, privileged message, object share + grant, feed
// read, grant/relationship revocation, block, and resolver candidate promotion.
//
// Cross-agent deliveries (friend req/resp, object share, message) go through a
// pluggable Transport so the SAME steps run two ways:
//   - LOCAL (default): envelopes applied directly via store.receiveEnvelope.
//   - HOST: envelopes sent over the real host mailbox (see scripts/lib/host-transport.ts).
// Each step is recorded as {name, ok, detail}; negative steps assert DENIAL.
import path from "node:path";
import { EdgeBookStore, EdgeBookError } from "../../src/edge-book.ts";
import type { AgentCard, MessageEnvelope } from "../../src/edge-book.ts";
import { writeCandidate, promoteCandidate, resolveTarget, defaultProviders } from "../../src/resolver.ts";

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AgentRuntime {
  home: string;
  store: EdgeBookStore;
  card: AgentCard;
}

// Deliver an envelope authored by `from` so that `to` applies it; resolve once
// `applied` reports true. Local applies synchronously; host sends over the wire.
export interface SmokeTransport {
  name: string;
  deliver(from: AgentRuntime, to: AgentRuntime, envelope: MessageEnvelope, applied: () => Promise<boolean>): Promise<void>;
  close(): Promise<void>;
}

export type TransportFactory = (agents: { alice: AgentRuntime; bob: AgentRuntime }) => Promise<SmokeTransport>;

export interface SmokeContext {
  alice: EdgeBookStore;
  bob: EdgeBookStore;
  carol: EdgeBookStore;
  aliceCard: AgentCard;
  bobCard: AgentCard;
  carolCard: AgentCard;
}

export interface SmokeOptions {
  dir: string;
  makeTransport?: TransportFactory;
  hooks?: { afterFriend?: (ctx: SmokeContext) => Promise<void> };
}

export interface SmokeResult {
  ok: boolean;
  transport: string;
  steps: SmokeStep[];
  dir: string;
  agents: { alice: string; bob: string; carol: string };
}

function inviteFor(card: AgentCard): string {
  return `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
}

async function createAgent(home: string, handle: string): Promise<AgentRuntime> {
  const store = new EdgeBookStore({ home });
  await store.init({ handle });
  const card = await store.writeCard();
  return { home, store, card };
}

// Default: in-process delivery via the store's unified envelope dispatcher.
export const localTransport: TransportFactory = async () => ({
  name: "local",
  async deliver(_from, to, envelope) {
    await to.store.receiveEnvelope(envelope);
  },
  async close() {},
});

async function relationship(store: EdgeBookStore, peerId: string): Promise<string> {
  return (await store.contacts())[peerId]?.relationship_state ?? "none";
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const dirs = {
    alice: path.join(opts.dir, "alice"),
    bob: path.join(opts.dir, "bob"),
    carol: path.join(opts.dir, "carol"),
  };
  const steps: SmokeStep[] = [];

  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      const detail = error instanceof Error ? `${(error as EdgeBookError).code ?? ""} ${error.message}`.trim() : String(error);
      steps.push({ name, ok: false, detail });
    }
  };
  const expectDenied = async (label: string, fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (error) {
      return `correctly denied (${(error as EdgeBookError).code ?? "error"})`;
    }
    throw new Error(`${label} was NOT denied`);
  };

  const alice = await createAgent(dirs.alice, "alice.smoke.local");
  const bob = await createAgent(dirs.bob, "bob.smoke.local");
  const carol = await createAgent(dirs.carol, "carol.smoke.local");
  await alice.store.setProfile({ name: "Alice", bio: "Alice bio", socials: [{ label: "telegram", value: "@alice" }] });
  await bob.store.setProfile({ name: "Bob", bio: "Bob bio" });
  const ctx: SmokeContext = {
    alice: alice.store, bob: bob.store, carol: carol.store,
    aliceCard: alice.card, bobCard: bob.card, carolCard: carol.card,
  };

  const transport = await (opts.makeTransport ?? localTransport)({ alice, bob });

  try {
    await step("onboard: three agents have valid signed cards", async () => {
      if (!alice.card.agent_id || !bob.card.agent_id || !carol.card.agent_id) throw new Error("missing agent_id");
      return `alice=${alice.card.agent_id.slice(0, 12)} bob=${bob.card.agent_id.slice(0, 12)} carol=${carol.card.agent_id.slice(0, 12)}`;
    });

    await step("resolve: alice resolves bob's invite to a verified card", async () => {
      const result = await resolveTarget(alice.store, inviteFor(bob.card), { providers: defaultProviders() });
      if (result.status !== "resolved" || result.card?.agent_id !== bob.card.agent_id) throw new Error(`unexpected status=${result.status}`);
      return `resolved ${result.card?.handle}`;
    });

    await step(`friend: alice and bob become mutual friends (via ${transport.name})`, async () => {
      const reqEnv = await alice.store.createFriendRequest(bob.card);
      await transport.deliver(alice, bob, reqEnv, async () => (await relationship(bob.store, alice.card.agent_id)) === "request_received");
      const respEnv = await bob.store.acceptFriend(alice.card.agent_id);
      await transport.deliver(bob, alice, respEnv, async () => (await relationship(alice.store, bob.card.agent_id)) === "friend");
      const af = await relationship(alice.store, bob.card.agent_id);
      const bf = await relationship(bob.store, alice.card.agent_id);
      if (af !== "friend" || bf !== "friend") throw new Error(`states a=${af} b=${bf}`);
      return "both friend";
    });

    await step(`profile: bidirectional friend profile exchange (via ${transport.name})`, async () => {
      // Alice applies the accepted friend_response and gets back a follow-up profile_share to deliver.
      const followUpEnv = await alice.store.buildProfileShareEnvelope(bob.card.agent_id);
      await transport.deliver(alice, bob, followUpEnv, async () => {
        const contact = (await bob.store.contacts())[alice.card.agent_id];
        return Boolean(contact?.friend_profile?.name);
      });
      const aliceSeesBob = (await alice.store.contacts())[bob.card.agent_id].friend_profile?.name === "Bob";
      const bobSeesAlice = (await bob.store.contacts())[alice.card.agent_id].friend_profile?.name === "Alice";
      if (!aliceSeesBob) throw new Error("alice does not see Bob's friend profile");
      if (!bobSeesAlice) throw new Error("bob does not see Alice's friend profile");
      return `bidirectional: alice sees Bob=${aliceSeesBob}, bob sees Alice=${bobSeesAlice}`;
    });

    if (opts.hooks?.afterFriend) await opts.hooks.afterFriend(ctx);

    await step(`message: alice sends a privileged message, bob receives it (via ${transport.name})`, async () => {
      const envelope = await alice.store.sendPrivilegedMessage(bob.card.agent_id, { text: "smoke hello" });
      await transport.deliver(alice, bob, envelope, async () => (await bob.store.inbox()).some((e) => e.message_id === envelope.message_id));
      if (!(await bob.store.inbox()).some((e) => e.message_id === envelope.message_id)) throw new Error("message not in bob inbox");
      return `delivered ${envelope.message_id}`;
    });

    const object = await alice.store.createObject({ title: "Smoke request", body: "please review" });
    await step(`object: alice shares an object+grant; bob can read, non-friend carol cannot (via ${transport.name})`, async () => {
      const shareEnv = await alice.store.shareObjectEnvelope(bob.card.agent_id, object.object_id);
      await transport.deliver(alice, bob, shareEnv, async () => bob.store.canReadObject(object.object_id, bob.card.agent_id));
      const bobAllowed = await bob.store.canReadObject(object.object_id, bob.card.agent_id);
      const carolAllowed = await alice.store.canReadObject(object.object_id, carol.card.agent_id);
      if (!bobAllowed) throw new Error("bob denied despite grant");
      if (carolAllowed) throw new Error("non-friend carol was allowed — leak!");
      return "bob allowed, carol denied";
    });

    await step("feed: alice grants feed.read.friends and serves her friends-feed", async () => {
      await alice.store.createPost({ title: "Smoke post", body: "hi friends", visibility: "friends", status: "published" });
      await alice.store.issueGrant(bob.card.agent_id, ["feed.read.friends"]);
      const posts = await alice.store.visiblePostsForPeer(bob.card.agent_id);
      return `${posts.length} friend-visible post(s)`;
    });

    await step("revoke: after revoking bob's object grant, his read is denied", async () =>
      expectDenied("revoked object read", async () => {
        await alice.store.revokeObjectGrant(object.object_id, bob.card.agent_id);
        if (await alice.store.canReadObject(object.object_id, bob.card.agent_id)) return;
        throw new EdgeBookError("revoked", "grant revoked");
      })
    );

    await step("candidate: a discovery candidate for carol promotes to a verified contact", async () => {
      const cand = await writeCandidate(alice.store, {
        source: "index", confidence: "low", display_name: "Carol", reason: "smoke opportunity", card_url: inviteFor(carol.card),
      });
      const envelope = await promoteCandidate(alice.store, cand.candidate_id);
      if (envelope.type !== "friend_request") throw new Error(`unexpected envelope ${envelope.type}`);
      if (!(await alice.store.contacts())[carol.card.agent_id]) throw new Error("carol contact not created");
      return "carol promoted to contact";
    });

    await step("block: after blocking bob, a privileged message is explicitly denied", async () =>
      expectDenied("message to blocked peer", async () => {
        await alice.store.block(bob.card.agent_id);
        await alice.store.sendPrivilegedMessage(bob.card.agent_id, { text: "after block" });
      })
    );
  } finally {
    await transport.close().catch(() => undefined);
  }

  return { ok: steps.every((s) => s.ok), transport: transport.name, steps, dir: opts.dir, agents: dirs };
}
