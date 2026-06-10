import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNotifyCmd } from "../src/notify.ts";

test("resolveNotifyCmd precedence: flag > env > config; blanks ignored", () => {
  assert.equal(resolveNotifyCmd({ flag: "F", env: "E", config: "C" }), "F");
  assert.equal(resolveNotifyCmd({ env: "E", config: "C" }), "E");
  assert.equal(resolveNotifyCmd({ config: "C" }), "C");
  assert.equal(resolveNotifyCmd({}), undefined);
  assert.equal(resolveNotifyCmd({ flag: "   ", env: "E" }), "E", "blank flag falls through");
  assert.equal(resolveNotifyCmd({ flag: "", config: "C" }), "C", "empty flag falls through");
});
