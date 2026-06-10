import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EdgeBookStore } from "../src/edge-book.ts";

test("export then import reproduces the same DID + handle", async () => {
  const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "eb-A-"));
  const a = new EdgeBookStore({ home: homeA });
  await a.init({ displayName: "Owner" });
  await a.setHandle("antony-evans");
  const bundle = await a.exportIdentity();

  const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "eb-B-"));
  const b = new EdgeBookStore({ home: homeB });
  await b.importIdentity(bundle);
  const idA = await a.identity();
  const idB = await b.identity();
  assert.equal(idB.agent_id, idA.agent_id);
  assert.equal(idB.handle, "antony-evans");
});

test("importIdentity refuses to clobber an existing identity without force", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "eb-C-"));
  const s = new EdgeBookStore({ home });
  await s.init({ displayName: "Existing" });
  const other = new EdgeBookStore({ home: await fs.mkdtemp(path.join(os.tmpdir(), "eb-D-")) });
  await other.init({ displayName: "Other" });
  const bundle = await other.exportIdentity();
  await assert.rejects(() => s.importIdentity(bundle), /identity_exists/);
  await assert.doesNotReject(() => s.importIdentity(bundle, { force: true }));
});
