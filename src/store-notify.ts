// Transport-free notification policy: which inbound envelope types notify the
// human, with what message, plus the dedup ledger that guards against
// double-notify across entry points (hook + cron + mailbox redelivery).
// Delivery (invoking the host notify command) lives in notify.ts.
//
// Extracted from EdgeBookStore (2026-06-10 size-compliance refactor); each
// public function is called by a same-named one-line delegate method on
// EdgeBookStore.
import { EdgeBookStore } from "./edge-book.ts";
import type { EscalationBody, FriendRequestBody, FriendResponseBody, MessageEnvelope, NotificationIntent, ObjectShareBody, SupportBundleBody } from "./types.ts";
import { readJson, writeJson } from "./fs-json.ts";
import { NOTIFIED_FILE } from "./store-files.ts";

type NotifyPolicy = (
  env: MessageEnvelope,
  store: EdgeBookStore,
) => Promise<NotificationIntent | null>; // null = silent

// Resolve a peer's display name from local contacts, falling back to the agent id.
async function peerName(store: EdgeBookStore, agentId: string): Promise<string | undefined> {
  return (await store.contacts())[agentId]?.display_name || undefined;
}

const NOTIFY_POLICIES: Partial<Record<MessageEnvelope["type"], NotifyPolicy>> = {
  friend_request: async (env, store) => {
    // Honour the per-type opt-out (default ON: treat undefined as enabled).
    if ((await store.config()).notify_on_friend_request === false) return null;
    const body = env.body as unknown as FriendRequestBody;
    const name = body.card?.display_name || env.from_agent_id;
    const note = body.note ? ` — “${body.note}”` : "";
    return {
      kind: "friend_request",
      from_id: env.from_agent_id,
      from_name: body.card?.display_name,
      message: `${name} wants to connect on Edge Book${note}. Reply “yes” to connect, or ignore to leave it pending.`,
      dedup_key: env.message_id,
    };
  },
  privileged_message: async (env, store) => {
    const body = env.body as { text?: unknown };
    const name = (await peerName(store, env.from_agent_id)) || env.from_agent_id;
    const text = typeof body.text === "string" ? body.text : "";
    const preview = text.length > 280 ? `${text.slice(0, 279)}…` : text;
    return {
      kind: "privileged_message",
      from_id: env.from_agent_id,
      from_name: await peerName(store, env.from_agent_id),
      message: `${name}: ${preview}`,
      dedup_key: env.message_id,
    };
  },
  friend_response: async (env) => {
    const body = env.body as unknown as FriendResponseBody;
    const name = body.card?.display_name || env.from_agent_id;
    const verb = body.accepted ? "accepted" : "declined";
    return {
      kind: "friend_response",
      from_id: env.from_agent_id,
      from_name: body.card?.display_name,
      message: `${name} ${verb} your friend request on Edge Book.`,
      dedup_key: env.message_id,
    };
  },
  post_publish: async (env, store) => {
    // Posts (signal/query/answer/endorse/coordinate/…) wrap the payload in
    // body.post. Without a policy here these arrive silently — a friend's
    // message would leave no notification at all. Surface a short preview.
    const post = (env.body as { post?: { post_type?: unknown; body?: unknown; text?: unknown } }).post;
    if (!post) return null;
    const name = (await peerName(store, env.from_agent_id)) || env.from_agent_id;
    const postType = typeof post.post_type === "string" ? post.post_type : "post";
    const raw =
      typeof post.body === "string" ? post.body :
      typeof post.text === "string" ? post.text :
      post.body != null ? JSON.stringify(post.body) : "";
    const preview = raw.length > 280 ? `${raw.slice(0, 279)}…` : raw;
    return {
      kind: "post_publish",
      from_id: env.from_agent_id,
      from_name: await peerName(store, env.from_agent_id),
      message: preview ? `${name} (${postType}): ${preview}` : `${name} sent a ${postType}.`,
      dedup_key: env.message_id,
    };
  },
  object_share: async (env, store) => {
    const body = env.body as unknown as ObjectShareBody;
    const name = (await peerName(store, env.from_agent_id)) || env.from_agent_id;
    const title = body.object?.request?.title || "an item";
    return {
      kind: "object_share",
      from_id: env.from_agent_id,
      from_name: await peerName(store, env.from_agent_id),
      message: `${name} shared a request: “${title}”.`,
      dedup_key: env.message_id,
    };
  },
  escalation: async (env) => {
    const body = env.body as unknown as EscalationBody;
    const esc = body.escalation;
    const opts = esc?.options?.length ? ` (options: ${esc.options.join(" / ")})` : "";
    return {
      kind: "escalation",
      from_id: env.from_agent_id,
      message: `${esc?.subject ?? "A decision is needed"} — ${esc?.body ?? ""}${opts}`,
      dedup_key: env.message_id,
    };
  },
  support_bundle: async (env) => {
    // spec-134 operator inbox. Message carries ids/refs only — never the report.
    const body = env.body as unknown as SupportBundleBody;
    const name = body.card?.display_name || env.from_agent_id;
    return {
      kind: "support_bundle",
      from_id: env.from_agent_id,
      from_name: body.card?.display_name,
      message: `${name} sent a support bundle (ref ${env.trace_id ?? env.message_id}). Review: edge-book support pending`,
      dedup_key: env.message_id,
    };
  },
};

// Compute the transport-free notification intent for an applied inbound envelope,
// or null when the type is silent / unregistered. Delivery (invoking the host
// notify command) is the entry point's job — this stays transport-free.
export async function notificationIntent(store: EdgeBookStore, envelope: MessageEnvelope): Promise<NotificationIntent | null> {
  const policy = NOTIFY_POLICIES[envelope.type];
  if (!policy) return null;
  const intent = await policy(envelope, store);
  if (!intent) return null;
  // Optional whitelist: when notify_types is set, only those kinds notify.
  const types = (await store.config()).notify_types;
  if (Array.isArray(types) && !types.includes(intent.kind)) return null;
  return intent;
}

// Notification dedup ledger (keyed by NotificationIntent.dedup_key). Guards
// against double-notify across entry points, hook+cron, and mailbox redelivery.
export async function wasNotified(store: EdgeBookStore, dedupKey: string): Promise<boolean> {
  const ledger = await readJson<string[]>(store.file(NOTIFIED_FILE), []);
  return ledger.includes(dedupKey);
}

export async function recordNotified(store: EdgeBookStore, dedupKey: string): Promise<void> {
  const ledger = await readJson<string[]>(store.file(NOTIFIED_FILE), []);
  if (ledger.includes(dedupKey)) return;
  ledger.push(dedupKey);
  await writeJson(store.file(NOTIFIED_FILE), ledger);
}

// Build a NotificationIntent for a pair_complete system event. Not backed by a
// MessageEnvelope — constructed directly and fed to the standard dedup + deliver
// pipeline. dedup_key = device_id so one notification fires per device regardless
// of redelivery. (spec-135)
export function buildPairCompleteNotifyIntent(deviceId: string, label: string): NotificationIntent {
  return {
    kind: "pair_complete",
    message: `Pairing complete — your reader is connected (device: ${label}).`,
    from_id: deviceId,
    dedup_key: deviceId,
  };
}
