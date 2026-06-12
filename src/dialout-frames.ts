// Host ↔ agent frame/ack shapes used by the dial-out client (extracted from
// dialout.ts, spec-142 size-compliance split — no shape changes). Canonical
// spec: edge-book-host/docs/wire-protocol.md — every frame shape here is
// FROZEN by that doc. dialout.ts re-exports everything so the package's
// public surface is unchanged.

export interface SessionsRevokeAck {
  type: "sessions_revoke_ok";
  request_id?: string;
  channel_id?: string;
}

// Per-device session management (ea-claude-057).
export interface DeviceInfo {
  device_id: string;
  label: string;
  created_at: number;
  last_seen_at: number;
}
export interface SessionsListAck { type: "sessions_list_ok"; request_id?: string; devices?: DeviceInfo[] }
export interface SessionRevokeOneAck { type: "session_revoke_one_ok"; request_id?: string; device_id?: string; revoked?: boolean }

// A delivered mailbox message (Contract 1, mirrors edge-book-host).
export interface MailboxDeliverFrame { type: "mailbox_deliver"; id: string; from: string; blob_b64: string; ts: number }

// Resolved mailbox_send acknowledgement (spec-097). recipient_live reports
// whether any live channel claimed the recipient at enqueue time; absent when
// the host predates receipts.
export interface MailboxSendAck { id: string; recipient_live?: boolean }

// One entry from mailbox_status_ok (spec-097). queued_ms/recipient_live are
// present only for queued/delivered (key omitted otherwise).
export interface MailboxStatusEntry { id: string; state: "queued" | "delivered" | "acked" | "unknown"; queued_ms?: number; recipient_live?: boolean }
