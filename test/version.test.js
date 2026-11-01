import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// The installed copy's mod.json is how someone tells which release they have, so it
// has to match the package version that the release is tagged with.
const root = new URL("../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("every mod.json carries the package version", () => {
  const { version } = read("package.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const mods = readdirSync(new URL("mods/", root));
  assert.ok(mods.length > 0);
  for (const name of mods) assert.equal(read(`mods/${name}/mod.json`).version, version, name);
});
