import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { deliverNotification } from "../src/notify.ts";
import type { NotificationIntent } from "../src/edge-book.ts";

function intentMin(over: Partial<NotificationIntent> = {}): NotificationIntent {
  return { kind: "friend_request", message: "hi", from_id: "did:x", dedup_key: "m0", ...over };
}

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "eb-deliver-"));
}

test("deliverNotification pipes message on stdin and fields on env", async () => {
  const dir = await tmp();
  const out = path.join(dir, "out.txt");
  const intent = intentMin({ kind: "friend_request", message: "Alice wants to connect", from_name: "Alice", dedup_key: "m1" });
  const cmd = `cat >> ${JSON.stringify(out)}; printf "\\n[%s|%s|%s]\\n" "$EB_NOTIFY_KIND" "$EB_NOTIFY_FROM_NAME" "$EB_NOTIFY_DEDUP_KEY" >> ${JSON.stringify(out)}`;

  const res = await deliverNotification(intent, { cmd });

  assert.equal(res.delivered, true);
  const written = await fs.readFile(out, "utf8");
  assert.match(written, /Alice wants to connect/, "message arrives on stdin");
  assert.match(written, /\[friend_request\|Alice\|m1\]/, "kind/from_name/dedup_key arrive on env");
});

test("untrusted fields are NOT shell-evaluated (injection-safe)", async () => {
  const dir = await tmp();
  const out = path.join(dir, "out.txt");
  const pwned = path.join(dir, "PWNED");
  const intent = intentMin({ kind: "privileged_message", message: "hi", from_name: `$(touch ${pwned})`, dedup_key: "m2" });
  const cmd = `echo "$EB_NOTIFY_FROM_NAME" >> ${JSON.stringify(out)}`;

  const res = await deliverNotification(intent, { cmd });

  assert.equal(res.delivered, true);
  assert.equal(existsSync(pwned), false, "command substitution in from_name must NOT execute");
  assert.match(await fs.readFile(out, "utf8"), /\$\(touch /, "literal untrusted value preserved, not evaluated");
});

test("non-zero exit -> delivered:false with error", async () => {
  const res = await deliverNotification(intentMin(), { cmd: "exit 3" });
  assert.equal(res.delivered, false);
  assert.ok(res.error, "error surfaced");
});

test("no notify_cmd configured -> not delivered, no spawn", async () => {
  const res = await deliverNotification(intentMin(), {});
  assert.equal(res.delivered, false);
});

test("a command that hangs is killed at the timeout and reported as failure", async () => {
  const res = await deliverNotification(intentMin(), { cmd: "sleep 10", timeoutMs: 150 });
  assert.equal(res.delivered, false);
  assert.match(String(res.error), /timeout/i);
});
