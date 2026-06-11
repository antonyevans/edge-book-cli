# spec-136 — Append-only audit log for scoped object access

> Design spec for EA task ea-claude-148. Authored 2026-06-11. Status: implemented on branch `feat/audit-jsonl`.

## Rule

Shared-object access is governed by explicit `object.read` grants. The local
agent appends one `audit.jsonl` record when an object grant is issued, an object
grant is revoked, an object is shared, or a `canReadObject` check denies access.

## Record Shape

Audit records keep the historic `action` field and add `kind` with the same
value. Records also include `created_at`, `actor_agent_id`, `peer_agent_id`,
and safe index fields when applicable: `object_id`, `grant_id`, `grant_ids`,
and `grant_scope`.

The log is append-only and best effort. Audit append failures are swallowed so
logging can never change the authorization path it observes.

## Sanitization

Required object-access audit events are sanitized by construction: ids, event
kinds, and grant scopes only. Object bodies, attachment bytes, message bodies,
private keys, and tokens are never written by these call sites.

`edge-book doctor` exposes a newest-last audit tail as a projection of those
safe fields only. It does not render raw `details` from historical audit
records.
