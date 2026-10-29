import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { initShared, pull, push, clearAll } from "../src/shared.js";

const fresh = () => { const db = openDb(":memory:"); initShared(db); return db; };

test("shared records: changes since a revision, per-record merge, deletes", () => {
  const db = fresh();
  const a = push(db, { upserts: [{ coll: "claims", id: "C1", data: { id: "C1", net: 100 } }, { coll: "claims", id: "C2", data: { id: "C2", net: 50 } }],
    settings: { raSeq: 3, posted: { f1: "2026-10-01" } }, log: [{ t: "x" }] }, "desk");
  const all = pull(db, 0);
  assert.equal(all.rev, a.rev);
  assert.equal(all.changes.filter(c => c.coll === "claims").length, 2);
  assert.deepEqual(all.log, [{ t: "x" }]);
  // Another browser edits C2 only; the first browser sees just that change
  push(db, { upserts: [{ coll: "claims", id: "C2", data: { id: "C2", net: 60 } }], settings: { raSeq: 2, posted: { f2: "2026-10-02" } } }, "billing");
  const since = pull(db, a.rev);
  const byKey = Object.fromEntries(since.changes.map(c => [c.coll + ":" + c.id, c.data]));
  assert.deepEqual(byKey["claims:C2"], { id: "C2", net: 60 });
  assert.equal(byKey["claims:C1"], undefined);
  assert.equal(byKey["_:raSeq"], undefined, "the remittance counter never goes down");
  assert.deepEqual(byKey["_:posted"], { f1: "2026-10-01", f2: "2026-10-02" });
  // Copying in an older browser's data adds only what is new
  const r = push(db, { upserts: [{ coll: "claims", id: "C1", data: { id: "C1", net: 1 } }, { coll: "claims", id: "C3", data: { id: "C3" } }], onlyNew: true });
  assert.equal(r.skipped, 1);
  const now = pull(db, 0).changes.filter(c => c.coll === "claims");
  assert.deepEqual(now.map(c => c.id).sort(), ["C1", "C2", "C3"]);
  assert.equal(now.find(c => c.id === "C1").data.net, 100);
  // Deletes reach other browsers as null
  const before = pull(db, 0).rev;
  push(db, { deletes: [{ coll: "claims", id: "C3" }] });
  assert.deepEqual(pull(db, before).changes, [{ coll: "claims", id: "C3", data: null }]);
  assert.throws(() => push(db, { upserts: [{ coll: "users", id: "1", data: {} }] }), /Malformed/);
  const cut = pull(db, 0).rev;
  clearAll(db, "owner");
  assert.ok(pull(db, cut).changes.every(c => c.data === null));
  assert.equal(pull(db, 0).changes.length, 0);
});
