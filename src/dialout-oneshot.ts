// One-shot dial-out helpers: connect, do one operation, disconnect.
// Extracted from dialout.ts to keep that file within the 500-line limit.
import { EdgeBookDialoutClient } from "./dialout.ts";
import type { DialoutClientOptions, DeviceInfo, MailboxSendAck, MailboxStatusEntry } from "./dialout.ts";
import { DEFAULT_PAIR_TTL_MS } from "./dialout-key.ts";
import type { PairRegistration, SessionsRevokeFrame } from "./dialout-key.ts";
import type { MessageEnvelope } from "./edge-book.ts";

export async function sendPairRegistration(options: DialoutClientOptions & { ttlMs?: number }): Promise<PairRegistration> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const registration = await client.pair(options.ttlMs ?? DEFAULT_PAIR_TTL_MS);
  await client.stop();
  return registration;
}

// Deliver a single signed envelope over the host mailbox using a transient
// dial-out connection (connect → mailbox_send → wait ack → disconnect). Used by
// the CLI `object share/revoke --deliver` and `friend ... --deliver` flows.
export async function deliverEnvelopeViaMailbox(options: DialoutClientOptions & { envelope: MessageEnvelope }): Promise<MailboxSendAck> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await client.sendEnvelope(options.envelope);
  } finally {
    await client.stop();
  }
}

export async function sendSessionsRevoke(options: DialoutClientOptions): Promise<SessionsRevokeFrame> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { frame, ack } = await client.revokeSessionsAndWait();
  await client.stop();
  return { ...frame, channel_id: ack.channel_id } as SessionsRevokeFrame & { channel_id?: string };
}

// List remembered devices via a transient dial-out connection (ea-claude-057).
export async function listSessions(options: DialoutClientOptions): Promise<DeviceInfo[]> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try { return await client.listSessionsAndWait(); } finally { await client.stop(); }
}

// Revoke ONE device by id via a transient dial-out connection (ea-claude-057).
export async function revokeOneSession(options: DialoutClientOptions & { deviceId: string }): Promise<boolean> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try { return await client.revokeOneSessionAndWait(options.deviceId); } finally { await client.stop(); }
}

// Query per-message delivery state via a transient dial-out connection
// (spec-097). Returns null when the host does not support receipts.
export async function mailboxStatus(options: DialoutClientOptions & { ids: string[]; timeoutMs?: number }): Promise<MailboxStatusEntry[] | null> {
  const client = new EdgeBookDialoutClient({ ...options, reconnect: false, openLocalApi: false });
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try { return await client.mailboxStatusAndWait(options.ids, options.timeoutMs ?? 5_000); } finally { await client.stop(); }
}
