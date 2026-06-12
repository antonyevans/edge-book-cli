// spec-145 — starter-pack CLI: `pack list` / `pack show` / `pack join`.
// A pack is curation, not trust: join resolves each member handle through the
// spec-138 resolver path and sends NORMAL friend requests; skip states make
// re-join idempotent; one member's failure never aborts the rest.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";
import { handleCli } from "../src/cli.ts";
import { PACK_JOIN_REQUEST_DELAY_MS } from "../src/cli-pack.ts";

const RELAY = "http://relay.test";

interface Member { home: string; store: EdgeBookStore; card: Awaited<ReturnType<EdgeBookStore["writeCard"]>>; handle: string }

async function makeMember(root: string, handle: string): Promise<Member> {
  const home = path.join(root, handle);
  await handleCli(["init", "--home", home, "--handle", handle, "--no-greeter"]);
  const store = new EdgeBookStore({ home });
  await store.updateConfig({ relay_url: RELAY });
  const card = await store.writeCard();
  return { home, store, card, handle };
}

// Fetch mock serving the pack registry, the handle registry, and the relay
// transport — the same shape test/friend-request-resolver.test.ts uses.
function mockHost(packs: Record<string, { title: string; description?: string; member_handles: string[] }>, members: Member[]) {
  const posted: Array<{ url: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith("/packs")) {
      return new Response(JSON.stringify(Object.entries(packs).map(([slug, p]) => ({ slug, title: p.title, description: p.description ?? "", member_count: p.member_handles.length }))), { status: 200 });
    }
    const packMatch = url.match(/\/pack\/([^/?]+)$/);
    if (packMatch) {
      const p = packs[decodeURIComponent(packMatch[1])];
      return p
        ? new Response(JSON.stringify({ slug: packMatch[1], title: p.title, description: p.description ?? "", member_handles: p.member_handles }), { status: 200 })
        : new Response(JSON.stringify({ error: "pack_not_found" }), { status: 404 });
    }
    const handleMatch = url.match(/\/handle\/([^/?]+)$/);
    if (handleMatch) {
      const m = members.find((x) => x.handle === decodeURIComponent(handleMatch[1]));
      return m ? new Response(JSON.stringify(m.card), { status: 200 }) : new Response(null, { status: 404 });
    }
    if (url.includes("/relay/") && init?.method === "POST") {
      posted.push({ url });
      return new Response(JSON.stringify({ ok: true, queued: 1 }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = original; } };
}

async function joinerWith(root: string): Promise<{ home: string; store: EdgeBookStore }> {
  const home = path.join(root, "joiner");
  await handleCli(["init", "--home", home, "--handle", "pack-joiner", "--no-greeter"]);
  return { home, store: new EdgeBookStore({ home }) };
}

test("pack join sends one resolver-routed request per eligible member; outbox records every send", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-join-"));
  const bob = await makeMember(root, "pack-bob");
  const carol = await makeMember(root, "pack-carol");
  const { home } = await joinerWith(root);
  const { posted, restore } = mockHost({ ev: { title: "Event", member_handles: ["pack-bob", "pack-carol"] } }, [bob, carol]);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "ev", "--deliver", "--relay-base", RELAY]);
    const json = result.json as { requested: number; skipped: number; failed: number; members: unknown[] };
    assert.equal(json.requested, 2, JSON.stringify(json.members));
    assert.equal(json.failed, 0);
    assert.equal(result.exitCode ?? 0, 0);
    assert.equal(posted.length, 2, "one relay send per member");
    const joiner = new EdgeBookStore({ home });
    const contacts = await joiner.contacts();
    assert.equal(contacts[bob.card.agent_id]?.relationship_state, "request_sent");
    assert.equal(contacts[carol.card.agent_id]?.relationship_state, "request_sent");
    const outbox = JSON.parse(await fs.readFile(path.join(home, "outbox.json"), "utf8")) as unknown[];
    assert.equal(outbox.length, 2, "outbox records every send");
  } finally { restore(); }
});

test("skip states: self, friend, request_sent, blocked, request_received (pending inbound preserved)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-skip-"));
  const friendM = await makeMember(root, "pack-friend");
  const sentM = await makeMember(root, "pack-sent");
  const blockedM = await makeMember(root, "pack-blocked");
  const inboundM = await makeMember(root, "pack-inbound");
  const { home, store: joiner } = await joinerWith(root);
  await joiner.updateConfig({ relay_url: RELAY });
  const joinerCard = await joiner.writeCard();

  await joiner.upsertContactFromCard(friendM.card, "friend");
  await joiner.upsertContactFromCard(sentM.card, "request_sent");
  await joiner.upsertContactFromCard(blockedM.card, "blocked");
  // Genuine inbound request from inboundM → joiner holds request_received.
  const inboundEnvelope = await inboundM.store.createFriendRequest(joinerCard);
  await joiner.receiveEnvelope(inboundEnvelope);
  const before = (await joiner.contacts())[inboundM.card.agent_id];
  assert.equal(before?.relationship_state, "request_received");

  const pack = { title: "All skips", member_handles: ["pack-joiner", "pack-friend", "pack-sent", "pack-blocked", "pack-inbound"] };
  const { posted, restore } = mockHost({ skips: pack }, [friendM, sentM, blockedM, inboundM]);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "skips", "--deliver", "--relay-base", RELAY]);
    const json = result.json as { requested: number; skipped: number; failed: number; members: Array<{ handle: string; reason?: string }> };
    assert.equal(json.requested, 0);
    assert.equal(json.skipped, 5);
    assert.equal(json.failed, 0);
    assert.equal(result.exitCode ?? 0, 0, "benign skips exit 0");
    assert.equal(posted.length, 0, "nothing sent");
    const inboundReason = json.members.find((m) => m.handle === "pack-inbound")?.reason ?? "";
    assert.match(inboundReason, /friend pending/, "request_received skip points at friend pending");
    const after = (await joiner.contacts())[inboundM.card.agent_id];
    assert.equal(after?.relationship_state, "request_received", "pending inbound state untouched");
  } finally { restore(); }
});

test("one unresolvable member does not abort the rest; partial failure exits 1; idempotent re-join sends nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-partial-"));
  const bob = await makeMember(root, "pack-bob2");
  const { home } = await joinerWith(root);
  const pack = { title: "Mixed", member_handles: ["ghost-handle", "pack-bob2"] };
  const { posted, restore } = mockHost({ mixed: pack }, [bob]);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "mixed", "--deliver", "--relay-base", RELAY]);
    const json = result.json as { requested: number; failed: number };
    assert.equal(json.requested, 1, "good member still requested after the bad one");
    assert.equal(json.failed, 1);
    assert.equal(result.exitCode, 1, "partial failure exits 1");

    const again = await handleCli(["pack", "join", "--home", home, "mixed", "--deliver", "--relay-base", RELAY]);
    const j2 = again.json as { requested: number; skipped: number };
    assert.equal(j2.requested, 0, "re-join sends nothing new");
    assert.equal(j2.skipped, 1);
    assert.equal(posted.length, 1, "no second send for the already-requested member");
  } finally { restore(); }
});

test("total failure exits 2", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-total-"));
  const { home } = await joinerWith(root);
  const { restore } = mockHost({ bad: { title: "Bad", member_handles: ["ghost-1", "ghost-2"] } }, []);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "bad", "--deliver", "--relay-base", RELAY]);
    assert.equal(result.exitCode, 2);
  } finally { restore(); }
});

test("pacing: PACK_JOIN_REQUEST_DELAY_MS is exactly 250 and is honoured between sends", async () => {
  assert.equal(PACK_JOIN_REQUEST_DELAY_MS, 250);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-pace-"));
  const bob = await makeMember(root, "pace-bob");
  const carol = await makeMember(root, "pace-carol");
  const { home } = await joinerWith(root);
  const { posted, restore } = mockHost({ pace: { title: "Pace", member_handles: ["pace-bob", "pace-carol"] } }, [bob, carol]);
  try {
    const started = Date.now();
    await handleCli(["pack", "join", "--home", home, "pace", "--deliver", "--relay-base", RELAY]);
    assert.equal(posted.length, 2);
    assert.ok(Date.now() - started >= PACK_JOIN_REQUEST_DELAY_MS, "delay applied between the two sends");
  } finally { restore(); }
});

test("pack show resolves members but sends nothing; pack list renders the public listing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-show-"));
  const bob = await makeMember(root, "show-bob");
  const { home, store: joiner } = await joinerWith(root);
  const contactsBefore = JSON.stringify(await joiner.contacts());
  const { posted, restore } = mockHost({ ev: { title: "Event", description: "desc", member_handles: ["show-bob"] } }, [bob]);
  try {
    const list = await handleCli(["pack", "list", "--home", home, "--relay-base", RELAY]);
    assert.match(list.text, /ev\s+Event\s+\(1 member\)/);
    const show = await handleCli(["pack", "show", "--home", home, "ev", "--relay-base", RELAY]);
    assert.match(show.text, /show-bob\s+resolved/);
    assert.equal(posted.length, 0, "show/list send nothing");
    assert.equal(JSON.stringify(await joiner.contacts()), contactsBefore, "no contact state changes");
  } finally { restore(); }
});

test("onboarding copy: pack path present and ordered before the share-your-link fallback (onboard.md + init note)", () => {
  const onboard = readFileSync(new URL("../skills/edge-book/prompts/onboard.md", import.meta.url), "utf8");
  const packIdx = onboard.indexOf("pack join");
  const fallbackIdx = onboard.indexOf("card invite");
  assert.ok(packIdx !== -1, "onboard.md mentions pack join");
  assert.ok(onboard.includes("pack list"), "onboard.md mentions pack list");
  assert.ok(fallbackIdx !== -1 && packIdx < fallbackIdx, "pack path comes BEFORE the share-your-link fallback");
  const onboarding = readFileSync(new URL("../src/onboarding.ts", import.meta.url), "utf8");
  assert.ok(onboarding.includes("pack join <slug> --deliver"), "init console note carries the pack line");
});

// Review-finding regressions (fresh-context review, 2026-06-12).
test("join without --deliver surfaces envelopes for manual transport (state is request_sent, nothing silently dropped)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-nodeliver-"));
  const bob = await makeMember(root, "nd-bob");
  const { home } = await joinerWith(root);
  const { posted, restore } = mockHost({ nd: { title: "ND", member_handles: ["nd-bob"] } }, [bob]);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "nd", "--relay-base", RELAY]);
    const json = result.json as { requested: number; members: Array<{ envelope?: { type: string } }> };
    assert.equal(json.requested, 1);
    assert.equal(posted.length, 0, "nothing was sent");
    assert.equal(json.members[0]?.envelope?.type, "friend_request", "envelope surfaced for manual transport");
    assert.match(result.text, /nothing was sent/i, "text warns that no delivery happened");
  } finally { restore(); }
});

test("pack show then join inside the host rate window: join falls back to the cached pack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-cache-"));
  const bob = await makeMember(root, "cache-bob");
  const { home } = await joinerWith(root);
  let packFetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (/\/pack\/cachepack$/.test(url)) {
      packFetches++;
      return packFetches === 1
        ? new Response(JSON.stringify({ slug: "cachepack", title: "C", description: "", member_handles: ["cache-bob"] }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error: "rate_limited", retry_after_ms: 600000 }), { status: 429 });
    }
    if (url.includes("/handle/cache-bob")) return new Response(JSON.stringify(bob.card), { status: 200 });
    if (url.includes("/relay/") && init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    await handleCli(["pack", "show", "--home", home, "cachepack", "--relay-base", RELAY]);
    const join = await handleCli(["pack", "join", "--home", home, "cachepack", "--deliver", "--relay-base", RELAY]);
    const json = join.json as { requested: number };
    assert.equal(json.requested, 1, "join succeeded via the cached pack despite the 429");
    assert.equal(packFetches, 2, "host saw exactly one real fetch plus one 429");
  } finally { globalThis.fetch = original; }
});

test("re-join skips a known member even when its stored card_url is a foreign file:// path (0.15.x cards)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-pack-foreign-"));
  const bob = await makeMember(root, "foreign-bob");
  const { home, store: joiner } = await joinerWith(root);
  // Simulate the live-fleet shape: contact exists in request_sent with a
  // card_url pointing at the PEER's own filesystem (unreadable here).
  await joiner.upsertContactFromCard(bob.card, "request_sent");
  const contacts = await joiner.contacts();
  contacts[bob.card.agent_id].card_url = "file:///opt/data/home/.openclaw/edge-book/openclaw-agent.json";
  contacts[bob.card.agent_id].aliases = ["foreign-bob"];
  await joiner.saveContacts(contacts);
  const { posted, restore } = mockHost({ fp: { title: "FP", member_handles: ["foreign-bob"] } }, [bob]);
  try {
    const result = await handleCli(["pack", "join", "--home", home, "fp", "--deliver", "--relay-base", RELAY]);
    const json = result.json as { requested: number; skipped: number; failed: number };
    assert.equal(json.failed, 0, "foreign card_url must not fail the member");
    assert.equal(json.skipped, 1, "skipped via pre-resolution alias check");
    assert.equal(result.exitCode ?? 0, 0);
    assert.equal(posted.length, 0);
  } finally { restore(); }
});

test("friend request on a contact with an unusable stored card_url falls back to registry resolution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eb-freq-foreign-"));
  const bob = await makeMember(root, "fr-bob");
  const { home, store: joiner } = await joinerWith(root);
  // Contact exists in a NON-skip state (rejected/none analogue: use a bare
  // contact with no relationship gate) whose card_url is foreign.
  await joiner.upsertContactFromCard(bob.card, "none");
  const contacts = await joiner.contacts();
  contacts[bob.card.agent_id].card_url = "file:///nonexistent/openclaw-agent.json";
  contacts[bob.card.agent_id].aliases = ["fr-bob"];
  await joiner.saveContacts(contacts);
  const { posted, restore } = mockHost({}, [bob]);
  try {
    const result = await handleCli(["friend", "request", "--home", home, "fr-bob", "--deliver", "--relay-base", RELAY]);
    assert.ok(result.text.includes("Sent") || posted.length === 1, "request sent via registry fallback, no ENOENT");
  } finally { restore(); }
});
