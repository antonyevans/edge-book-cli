// Human-handle slug rules (spec-096).
// Human-handle slug rules. MUST match the host's isValidSlug in
// edge-book-host/src/handles.ts (same regex + reserved set).
const HANDLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_HANDLES = new Set(["add", "healthz", "metrics", "agent", "api", "handle", "auth", "directory"]);
export function isValidHandle(handle: string): boolean {
  return HANDLE_SLUG.test(handle) && !RESERVED_HANDLES.has(handle);
}
export function slugifyHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}
