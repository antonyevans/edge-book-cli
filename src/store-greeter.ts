// spec-132 greeter agent: the auto-accept + welcome-share pass. PURE store
// logic — takes the store, returns the envelopes to deliver, never touches the
// network. Delivery wiring lives in cli-social.ts (`friend auto-accept`),
// copied from the existing `friend accept --deliver` pattern.
//
// Invariants:
//   - hard-gated on config greeter_mode === true (greeter_mode_required) so no
//     normal agent can stumble into auto-accepting strangers;
//   - exactly ONE welcome object, created lazily on first need and pinned via
//     config.greeter_welcome_object_id (the stable marker, spec §C);
//   - welcome dedup rides the spec-125 ledger (store-notify.ts) with keys
//     `greeter_welcome:<agent_id>`. The key is recorded when the share envelope
//     is BUILT (before delivery): a crash between accept and welcome cannot
//     double-send; the trade-off (build-then-crash = welcome never delivered)
//     is the spec-chosen failure mode;
//   - crash recovery: friends missing their ledger key get a welcome-only entry
//     on the next pass (accepted: false, welcomed: true).
import { EdgeBookStore } from "./edge-book.ts";
import { EdgeBookError } from "./types.ts";
import type { MessageEnvelope } from "./types.ts";

export const GREETER_WELCOME_TITLE = "Welcome to Edge Book";

// Human-vocabulary copy (spec §C): first share, agent can read it to you,
// "take it back" works both ways. Must pass the banned-vocabulary guard.
export const GREETER_WELCOME_BODY =
  "Hi, and welcome! This is your first share on Edge Book. Your agent can read it to you whenever you ask. " +
  "Sharing works both ways here: when someone shares with you, you can read it until they take it back — " +
  "and anything you share, you can take back too. Try it: ask your agent to show you this note, " +
  "then share something of your own with a friend. Curious who else is here? Ask your agent: edge-book directory. Glad you're here.";

export function greeterWelcomeKey(agentId: string): string {
  return `greeter_welcome:${agentId}`;
}

export interface GreeterPassEntry {
  agent_id: string;
  accepted: boolean;
  welcomed: boolean;
  accept_envelope?: MessageEnvelope;
  share_envelope?: MessageEnvelope;
}

// Ensure the single welcome object exists; pin its id in config on first create.
export async function ensureWelcomeObject(store: EdgeBookStore): Promise<string> {
  const config = await store.config();
  if (config.greeter_welcome_object_id) return config.greeter_welcome_object_id;
  const object = await store.createObject({ title: GREETER_WELCOME_TITLE, body: GREETER_WELCOME_BODY });
  await store.updateConfig({ greeter_welcome_object_id: object.object_id });
  return object.object_id;
}

// One greeter pass: accept every request_received contact (direct contacts scan —
// NOT pendingFriendRequests(), which filters by notified_at + notify config and
// would skip requests the notifier cron already pinged), then welcome every
// friend not yet in the ledger. Returns the envelopes for the caller to deliver.
export async function runGreeterPass(store: EdgeBookStore): Promise<GreeterPassEntry[]> {
  if ((await store.config()).greeter_mode !== true) {
    throw new EdgeBookError("greeter_mode_required", "friend auto-accept requires greeter mode (run: edge-book greeter --on)");
  }
  const contacts = Object.values(await store.contacts());
  const pending = contacts.filter((c) => c.relationship_state === "request_received");
  const friends = contacts.filter((c) => c.relationship_state === "friend");

  const buildWelcome = async (peerAgentId: string): Promise<MessageEnvelope | undefined> => {
    if (await store.wasNotified(greeterWelcomeKey(peerAgentId))) return undefined;
    const welcomeObjectId = await ensureWelcomeObject(store);
    const envelope = await store.shareObjectEnvelope(peerAgentId, welcomeObjectId);
    await store.recordNotified(greeterWelcomeKey(peerAgentId));
    return envelope;
  };

  const entries: GreeterPassEntry[] = [];
  for (const contact of pending) {
    const accept_envelope = await store.acceptFriend(contact.peer_agent_id, "greeter auto-accept");
    const share_envelope = await buildWelcome(contact.peer_agent_id);
    entries.push({
      agent_id: contact.peer_agent_id,
      accepted: true,
      welcomed: Boolean(share_envelope),
      accept_envelope,
      ...(share_envelope ? { share_envelope } : {}),
    });
  }
  for (const contact of friends) {
    const share_envelope = await buildWelcome(contact.peer_agent_id);
    if (share_envelope) {
      entries.push({ agent_id: contact.peer_agent_id, accepted: false, welcomed: true, share_envelope });
    }
  }
  return entries;
}
