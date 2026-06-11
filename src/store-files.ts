// Storage layout of the agent home directory (~/.openclaw/edge-book by default).
// Every file name here is a PERSISTED FORMAT — agents in the field have these
// files on disk. Renaming one orphans existing data.

export const IDENTITY_FILE = "identity.json";
export const CONTACTS_FILE = "contacts.json";
export const GRANTS_FILE = "grants.json";
export const OBJECTS_FILE = "objects.json";
export const ATTACHMENTS_DIR = "attachments";
export const SEEN_MESSAGES_FILE = "seen-messages.json";
export const CONFIG_FILE = "config.json";
export const RELATIONSHIP_EVENTS_FILE = "relationship-events.jsonl";
export const MESSAGES_FILE = "messages.jsonl";
export const AUDIT_FILE = "audit.jsonl";
export const INBOX_FILE = "inbox.jsonl";
export const CARD_FILE = "openclaw-agent.json";
export const SESSIONS_FILE = "web-sessions.json";
export const POSTS_FILE = "posts.json";
export const FEED_FILE = "feed-items.json";
export const APPROVALS_FILE = "approvals.json";
export const NOTIFIED_FILE = "notified.json"; // dedup ledger for delivered notifications (ea-claude-125)
export const ESCALATIONS_FILE = "escalations.json";
export const CONTACT_MUTES_FILE = "contact-mutes.json";
export const REPORTS_FILE = "reports.json";
export const INVITE_CODES_FILE = "invite-codes.json";
export const INBOUND_RATE_FILE = "inbound-rate.json";
export const OUTBOX_FILE = "outbox.json"; // sender outbox ledger — JSON ARRAY, not keyed object (spec-097)
export const EVENTS_FILE = "events.ndjson"; // protocol event log ring buffer (ea-claude-137, spec-133)
export const SUPPORT_BUNDLES_FILE = "support-bundles.json"; // operator support inbox (spec-134)

// spec-0021 new post-type storage files
export const ATTESTATIONS_FILE = "attestations.json";
export const ENDORSEMENTS_FILE = "endorsements.json";
export const SIGNALS_FILE = "signals.json";
export const CAPABILITIES_FILE = "capabilities.json";
export const EPHEMERAL_FILE = "ephemeral-posts.json";
export const ANSWERS_FILE = "answers.json";
export const RECEIVED_POSTS_FILE = "received-posts.json";

export const DEFAULT_SIGNAL_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
