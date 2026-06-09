// Two-agent smoke framework (ea-openclaw-031). Host-free: creates independent
// EdgeBookStore agents on disk and drives the full local interaction surface —
// resolve, friend handshake, privileged message, object share + grant, feed
// read, grant/relationship revocation, block, and resolver candidate promotion.
// Each step is recorded as {name, ok, detail}; negative steps assert that an
// access is correctly DENIED. Reusable from tests and from scripts/smoke-2agent.ts.
import path from "node:path";
import { EdgeBookStore, EdgeBookError } from "../../src/edge-book.ts";
import type { AgentCard } from "../../src/edge-book.ts";
import { writeCandidate, promoteCandidate, resolveTarget, defaultProviders } from "../../src/resolver.ts";

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

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
  hooks?: { afterFriend?: (ctx: SmokeContext) => Promise<void> };
}

export interface SmokeResult {
  ok: boolean;
  steps: SmokeStep[];
  dir: string;
  agents: { alice: string; bob: string; carol: string };
}

function inviteFor(card: AgentCard): string {
  return `edgebook:invite:${Buffer.from(JSON.stringify(card), "utf8").toString("base64url")}`;
}

async function createAgent(home: string, handle: string): Promise<{ store: EdgeBookStore; card: AgentCard }> {
  const store = new EdgeBookStore({ home });
  await store.init({ handle });
  const card = await store.writeCard();
  return { store, card };
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const agents = {
    alice: path.join(opts.dir, "alice"),
    bob: path.join(opts.dir, "bob"),
    carol: path.join(opts.dir, "carol"),
  };
  const steps: SmokeStep[] = [];

  // Each step runs `fn`; ok = it did not throw. Negative steps make `fn` throw
  // when an access that should have been denied was instead ALLOWED.
  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
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

  // 1. onboard
  const a = await createAgent(agents.alice, "alice.smoke.local");
  const b = await createAgent(agents.bob, "bob.smoke.local");
  const c = await createAgent(agents.carol, "carol.smoke.local");
  const ctx: SmokeContext = {
    alice: a.store, bob: b.store, carol: c.store,
    aliceCard: a.card, bobCard: b.card, carolCard: c.card,
  };

  await step("onboard: three agents have valid signed cards", async () => {
    if (!a.card.agent_id || !b.card.agent_id || !c.card.agent_id) throw new Error("missing agent_id");
    return `alice=${a.card.agent_id.slice(0, 10)} bob=${b.card.agent_id.slice(0, 10)} carol=${c.card.agent_id.slice(0, 10)}`;
  });

  // 2. resolve Bob's invite (verify-before-connect)
  await step("resolve: alice resolves bob's invite to a verified card", async () => {
    const result = await resolveTarget(a.store, inviteFor(b.card), { providers: defaultProviders() });
    if (result.status !== "resolved" || result.card?.agent_id !== b.card.agent_id) {
      throw new Error(`unexpected status=${result.status}`);
    }
    return `resolved ${result.card?.handle}`;
  });

  // 3. friend handshake
  await step("friend: alice and bob become mutual friends", async () => {
    await b.store.receiveFriendRequest(await a.store.createFriendRequest(b.card));
    await a.store.applyFriendResponse(await b.store.acceptFriend(a.card.agent_id));
    const af = (await a.store.contacts())[b.card.agent_id]?.relationship_state;
    const bf = (await b.store.contacts())[a.card.agent_id]?.relationship_state;
    if (af !== "friend" || bf !== "friend") throw new Error(`states a=${af} b=${bf}`);
    return "both friend";
  });

  // fault-injection hook (tests use this to prove the framework detects breakage)
  if (opts.hooks?.afterFriend) await opts.hooks.afterFriend(ctx);

  // 4. privileged message round-trip
  await step("message: alice sends a privileged message, bob receives it", async () => {
    const envelope = await a.store.sendPrivilegedMessage(b.card.agent_id, { text: "smoke hello" });
    await b.store.receivePrivilegedMessage(envelope);
    return `delivered ${envelope.message_id}`;
  });

  // 5. object share + grant, with non-friend denial
  const object = await a.store.createObject({ title: "Smoke request", body: "please review" });
  await step("object: alice shares an object+grant; bob can read, non-friend carol cannot", async () => {
    const shareEnv = await a.store.shareObjectEnvelope(b.card.agent_id, object.object_id);
    await b.store.receiveObjectShare(shareEnv);
    const bobAllowed = await a.store.canReadObject(object.object_id, b.card.agent_id);
    const carolAllowed = await a.store.canReadObject(object.object_id, c.card.agent_id);
    if (!bobAllowed) throw new Error("bob denied despite grant");
    if (carolAllowed) throw new Error("non-friend carol was allowed — leak!");
    return "bob allowed, carol denied";
  });

  // 6. feed read with a friend grant
  await step("feed: alice grants feed.read.friends and serves her friends-feed", async () => {
    await a.store.createPost({ title: "Smoke post", body: "hi friends", visibility: "friends", status: "published" });
    await a.store.issueGrant(b.card.agent_id, ["feed.read.friends"]);
    const posts = await a.store.visiblePostsForPeer(b.card.agent_id);
    return `${posts.length} friend-visible post(s)`;
  });

  // 7. object grant revoke → read denied
  await step("revoke: after revoking bob's object grant, his read is denied", async () =>
    expectDenied("revoked object read", async () => {
      await a.store.revokeObjectGrant(object.object_id, b.card.agent_id);
      const stillAllowed = await a.store.canReadObject(object.object_id, b.card.agent_id);
      if (stillAllowed) return; // allowed → expectDenied throws
      throw new EdgeBookError("revoked", "grant revoked");
    })
  );

  // 8. resolver candidate promotion (Index-style discovery → verified contact)
  await step("candidate: a discovery candidate for carol promotes to a verified contact", async () => {
    const cand = await writeCandidate(a.store, {
      source: "index", confidence: "low", display_name: "Carol", reason: "smoke opportunity", card_url: inviteFor(c.card),
    });
    const envelope = await promoteCandidate(a.store, cand.candidate_id);
    if (envelope.type !== "friend_request") throw new Error(`unexpected envelope ${envelope.type}`);
    const carolContact = (await a.store.contacts())[c.card.agent_id];
    if (!carolContact) throw new Error("carol contact not created");
    return "carol promoted to contact";
  });

  // 9. block → explicit denial
  await step("block: after blocking bob, a privileged message is explicitly denied", async () =>
    expectDenied("message to blocked peer", async () => {
      await a.store.block(b.card.agent_id);
      await a.store.sendPrivilegedMessage(b.card.agent_id, { text: "after block" });
    })
  );

  return { ok: steps.every((s) => s.ok), steps, dir: opts.dir, agents };
}
