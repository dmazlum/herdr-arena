import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRows } from "../app/mods/arena/lib/diff.js";

const kinds = (rows) => rows.map((r) => r.kind + (r.number ?? ""));

test("headers, hunks and numbered lines", () => {
  const rows = diffRows([
    "diff --git a/src/a.js b/src/a.js",
    "index 1..2 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -3,2 +3,2 @@",
    " keep",
    "-old",
    "+new",
  ].join("\n"));
  assert.equal(rows[0].kind, "file");
  assert.equal(rows[0].text, "src/a.js");
  assert.deepEqual(kinds(rows), ["file", "meta", "meta", "meta", "@", " 3", "-4", "+4"]);
});

test("a removed '-- comment' and an added '++ x' are content inside a hunk", () => {
  const rows = diffRows([
    "@@ -1,3 +1,2 @@",
    "--- old sql comment",
    "+++ counter",
    " select 1;",
    "-drop table x;",
  ].join("\n"));
  assert.deepEqual(kinds(rows), ["@", "-1", "+1", " 2", "-3"]);
  assert.equal(rows[1].text, "-- old sql comment");
  assert.equal(rows[2].text, "++ counter");
});

test("a hunk header without counts covers one line; the next file starts after it", () => {
  const rows = diffRows(["@@ -1 +1 @@", "-a", "+b", "diff --git a/x b/x", "--- a/x"].join("\n"));
  assert.deepEqual(kinds(rows), ["@", "-1", "+1", "file", "meta"]);
});

test("'no newline at end of file' stays a note", () => {
  const rows = diffRows(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n"));
  assert.deepEqual(kinds(rows), ["@", "-1", "meta", "+1"]);
});
