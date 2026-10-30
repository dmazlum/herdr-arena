// The git helpers against a real repository in a temporary folder.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, mkdirSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as G from "../app/mods/arena/lib/git.js";

// The mod's exec, over child_process.
const exec = async (command, args = [], { cwd } = {}) => {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const sh = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

let dir, repo, base;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-git-"));
  repo = join(dir, "repo");
  sh(dir, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  base = sh(repo, "rev-parse", "HEAD");
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("a lane's changes count untracked files and leave the real index alone", async () => {
  const info = await G.repoOf(exec, repo);
  const wt = join(dir, "lane");
  await G.addWorktree(exec, info, wt, "arena/t/lane-1", base);
  writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  writeFileSync(join(wt, "new.txt"), "x\ny\n");
  const stat = await G.laneStat(exec, wt, base);
  assert.deepEqual({ files: stat.files, insertions: stat.insertions, deletions: stat.deletions }, { files: 2, insertions: 3, deletions: 0 });
  // Still unstaged and untracked: the throwaway index never reached the real one.
  assert.equal(sh(wt, "diff", "--cached", "--name-only"), "");
  assert.match(sh(wt, "status", "--porcelain"), /\?\? new\.txt/);
});

test("a snapshot holds the work, committed or not, and survives the worktree", async () => {
  const info = await G.repoOf(exec, repo);
  const wt = join(dir, "lane2");
  await G.addWorktree(exec, info, wt, "arena/t/lane-2", base);
  writeFileSync(join(wt, "committed.txt"), "c\n");
  sh(wt, "add", ".");
  sh(wt, "commit", "-qm", "lane commit");
  writeFileSync(join(wt, "loose.txt"), "l\n");
  const state = await G.laneStat(exec, wt, base);
  const ref = G.snapshotRef("r1", "l2");
  const snap = await G.snapshot(exec, wt, ref, state);
  await G.removeWorktree(exec, info, wt, "arena/t/lane-2");
  assert.equal(existsSync(wt), false);
  assert.equal(await G.branchExists(exec, info, "arena/t/lane-2"), false);
  assert.equal(sh(repo, "show", `${ref}:loose.txt`), "l");
  // Diffed from the run's base, the lane's own commit is part of its work.
  const diff = await G.rangeDiff(exec, repo, base, snap.commit);
  assert.match(diff, /committed\.txt/);
  assert.match(diff, /loose\.txt/);
});

test("range diffs ignore a configured external diff tool", async () => {
  sh(repo, "config", "diff.external", "false");
  try {
    const head = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const tree = (await G.stateTree(exec, repo)).tree;
    assert.match(await G.rangeDiff(exec, repo, head, tree), /^-one$/m);
  } finally {
    sh(repo, "config", "--unset", "diff.external");
    sh(repo, "checkout", "--", "a.txt");
  }
});

test("a detached HEAD is the base, not the newest branch", async () => {
  sh(repo, "branch", "newer");
  sh(repo, "checkout", "-q", "--detach", base);
  try {
    const b = await G.branches(exec, repo);
    assert.equal(b.current, "HEAD");
    assert.equal(b.detached, true);
    assert.equal(b.names[0], "HEAD");
  } finally {
    sh(repo, "checkout", "-q", "main");
  }
  const b = await G.branches(exec, repo);
  assert.deepEqual([b.current, b.detached], ["main", false]);
});

test("the instructed restore takes an attempt's deletions too", async () => {
  const info = await G.repoOf(exec, repo);
  const lane = join(dir, "lane-del");
  await G.addWorktree(exec, info, lane, "arena/t/del", base);
  unlinkSync(join(lane, "a.txt"));
  writeFileSync(join(lane, "b.txt"), "b\n");
  const snap = await G.snapshot(exec, lane, G.snapshotRef("r2", "l1"));
  const fusion = join(dir, "fusion");
  await G.addWorktree(exec, info, fusion, "arena/t/fusion", base);
  mkdirSync(join(fusion, "sub"));
  // From a subfolder, as an agent might be.
  sh(join(fusion, "sub"), "restore", `--source=${snap.commit}`, "--staged", "--worktree", "--", ":/");
  assert.equal(existsSync(join(fusion, "a.txt")), false);
  assert.equal(readFileSync(join(fusion, "b.txt"), "utf8"), "b\n");
});

test("the throwaway index starts from the real one and leaves it as it was", async () => {
  const index = sh(repo, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const before = statSync(index).mtimeMs;
  writeFileSync(join(repo, "loose.txt"), "l\n");
  try {
    const state = await G.stateTree(exec, repo);
    assert.match(sh(repo, "ls-tree", "--name-only", state.tree), /loose\.txt/);
    assert.equal(statSync(index).mtimeMs, before);
    assert.equal(sh(repo, "diff", "--cached", "--name-only"), "");
  } finally { unlinkSync(join(repo, "loose.txt")); }
});

test("a folder's place in its repo comes from git, through symlinks", async () => {
  mkdirSync(join(repo, "pkg", "api"), { recursive: true });
  writeFileSync(join(repo, "pkg", "api", "x.js"), "x\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "pkg");
  const link = join(dir, "link");
  symlinkSync(repo, link);
  assert.equal(await G.prefixOf(exec, join(link, "pkg", "api")), "pkg/api/");
  assert.equal(await G.prefixOf(exec, repo), "");
  const info = await G.repoOf(exec, repo);
  assert.equal(await G.folderAt(exec, info, "HEAD", "pkg/api/"), true);
  assert.equal(await G.folderAt(exec, info, base, "pkg/api/"), false);
  assert.equal(await G.folderAt(exec, info, base, ""), true);
});

test("each snapshot has its own ref, so an earlier one stays reachable", async () => {
  const a = G.snapshotRef("r3", "l1", "fusion", 1000);
  const b = G.snapshotRef("r3", "l1", "archive", 2000);
  assert.notEqual(a, b);
  assert.match(a, /^refs\/herdr-arena\/runs\/r3\/l1\/fusion-/);
  const info = await G.repoOf(exec, repo);
  const lane = join(dir, "lane-twice");
  await G.addWorktree(exec, info, lane, "arena/t/twice", base);
  writeFileSync(join(lane, "first.txt"), "1\n");
  const first = await G.snapshot(exec, lane, a);
  writeFileSync(join(lane, "second.txt"), "2\n");
  const second = await G.snapshot(exec, lane, b);
  assert.notEqual(first.commit, second.commit);
  assert.equal(sh(repo, "rev-parse", a), first.commit);
  assert.equal(sh(repo, "rev-parse", b), second.commit);
});

test("a deleted worktree is no checkout", async () => {
  const info = await G.repoOf(exec, repo);
  const lane = join(dir, "lane-gone");
  await G.addWorktree(exec, info, lane, "arena/t/gone", base);
  assert.equal(await G.isCheckout(exec, lane), true);
  rmSync(lane, { recursive: true, force: true });
  assert.equal(await G.isCheckout(exec, lane), false);
  sh(repo, "worktree", "prune");
  assert.doesNotMatch(sh(repo, "worktree", "list"), /lane-gone/);
});

test("the main checkout is never removed", async () => {
  const info = await G.repoOf(exec, repo);
  await assert.rejects(G.removeWorktree(exec, info, info.main, null), /main checkout/);
});
