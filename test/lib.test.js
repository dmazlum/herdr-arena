import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLaneStatus, isSettled, formatDuration, shellIsBack, laneSig, needsRead, readSettled, READ_RETRIES, READ_RETRY_MS } from "../mods/arena/lib/status.js";
import { slugify, titleFromPrompt, laneLabel, nextIndex, nextMemberId, laneBranch, worktreePath, splitCommand, laneArgv, agentWithTask, activeAfterRemoval } from "../mods/arena/lib/names.js";
import { fusionModeFor, mightInlineDiffs, diffsFit, utf8Length, answersPrompt, codePrompt, codeInstructions } from "../mods/arena/lib/fusion.js";
import { lastAnswer, screenTail, claudeProjectDir, codexLastAnswer, codexSessionMeta, opencodeSessionFor, opencodeLastAnswer } from "../mods/arena/lib/transcript.js";
import { parseNumstat } from "../mods/arena/lib/git.js";

const live = (extra = {}) => ({ state: "live", turn: 1, ...extra });

test("a blocked agent waits for the person, even while it counts as busy", () => {
  assert.equal(resolveLaneStatus({ terminal: live(), agent: { status: "blocked" }, reply: null }), "waiting");
});

test("a working agent is working", () => {
  assert.equal(resolveLaneStatus({ terminal: live({ turn: 0 }), agent: { status: "working" }, reply: null }), "working");
});

test("an ended terminal is stopped, or failed with an error code", () => {
  assert.equal(resolveLaneStatus({ terminal: null, agent: null, reply: null }), "stopped");
  assert.equal(resolveLaneStatus({ terminal: { state: "finished", exit_code: 1 }, agent: null, reply: null }), "failed");
});

test("no turn and no answer is not started", () => {
  assert.equal(resolveLaneStatus({ terminal: live({ turn: 0 }), agent: { status: "idle" }, reply: undefined }), "notStarted");
});

test("an ended turn without text is finished without an answer", () => {
  assert.equal(resolveLaneStatus({ terminal: live(), agent: { status: "done" }, reply: { state: "ready", text: "" } }), "noReply");
});

test("a screen tail does not count as an answer", () => {
  assert.equal(resolveLaneStatus({ terminal: live({ turn: 0 }), agent: { status: "idle" }, reply: { state: "ready", text: "$ codex", screen: true } }), "notStarted");
  assert.equal(resolveLaneStatus({ terminal: live(), agent: { status: "idle" }, reply: { state: "ready", text: "…", screen: true } }), "finished");
});

test("an agent that quit back to its shell keeps its answer", () => {
  assert.equal(resolveLaneStatus({ terminal: live(), agent: null, reply: { state: "ready", text: "Done." } }), "finished");
  const shell = { argv: ["/bin/zsh", "-i"] };
  assert.equal(resolveLaneStatus({ terminal: live({ turn: 0 }), agent: null, reply: { state: "ready", text: "" }, foreground: shell }), "stopped");
});

test("a lane still running its setup, or starting, has not started: it is not settled", () => {
  const setup = { argv: ["sh", "-c", "set -e\nnpm ci\nexec \"$@\"", "arena-setup", "claude"] };
  const starting = { argv: ["/bin/zsh", "-ic", "\"$@\"; exec \"$0\" -i", "/bin/zsh", "claude"] };
  for (const foreground of [setup, starting, null]) {
    const status = resolveLaneStatus({ terminal: live({ turn: 0 }), agent: null, reply: undefined, foreground });
    assert.equal(status, "notStarted");
    assert.equal(isSettled(status), false);
  }
});

test("a bare shell at its prompt is back; one running a command is not", () => {
  assert.equal(shellIsBack({ argv: ["/bin/zsh", "-i"] }), true);
  assert.equal(shellIsBack({ argv: ["-zsh"] }), true);
  assert.equal(shellIsBack({ argv: ["bash", "-lc", "x"] }), false);
  assert.equal(shellIsBack({ argv: ["claude"] }), false);
  assert.equal(shellIsBack(null), false);
});

test("settled lanes are the ones fusion and Keep may use", () => {
  assert.deepEqual(["waiting", "working", "notStarted", "finished", "noReply", "failed", "stopped"].map(isSettled), [false, false, false, true, true, true, true]);
});

test("durations read like a clock", () => {
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(192_000), "3m 12s");
  assert.equal(formatDuration(3_840_000), "1h 4m");
});

test("slugs are safe branch parts", () => {
  assert.equal(slugify("Fix the Login bug!"), "fix-the-login-bug");
  assert.equal(slugify("Şehir çözümü"), "sehir-cozumu");
  assert.equal(slugify("!!!"), "run");
});

test("a title comes from the prompt's first line", () => {
  assert.equal(titleFromPrompt("\n  Add retries\nto the client"), "Add retries");
  assert.equal(titleFromPrompt(""), "Parallel run");
  assert.equal(titleFromPrompt("x".repeat(60)).length, 48);
});

test("lane labels number repeats and name variants", () => {
  const claude = { key: "claude", name: "Claude Code" };
  assert.equal(laneLabel({ role: "run", variant: "A", index: 1, agent: claude }, 1), "Claude Code");
  assert.equal(laneLabel({ role: "run", variant: "B", index: 2, agent: claude }, 2), "Claude Code #2 · B");
  assert.equal(laneLabel({ role: "fusion", variant: "F", index: 1, agent: claude }, 2), "Fusion · Claude Code");
});

test("repeat numbers count per agent and variant", () => {
  const members = [
    { role: "run", variant: "A", agent: { key: "claude" }, index: 1 },
    { role: "run", variant: "A", agent: { key: "claude" }, index: 2 },
    { role: "run", variant: "B", agent: { key: "claude" }, index: 1 },
  ];
  assert.equal(nextIndex(members, "A", "claude"), 3);
  assert.equal(nextIndex(members, "B", "claude"), 2);
  assert.equal(nextIndex(members, "A", "codex"), 1);
});

test("a detached lane keeps its repeat number taken", () => {
  const members = [{ role: "run", variant: "A", agent: { key: "claude" }, index: 1 }];
  const retired = [{ role: "run", variant: "A", agent: { key: "claude" }, index: 2 }];
  assert.equal(nextIndex(members, "A", "claude", retired), 3);
});

test("member ids are never handed out twice, even after members leave", () => {
  assert.deepEqual(nextMemberId({ members: [{ id: "l1" }, { id: "l2" }] }), { id: "l3", seq: 3 });
  // l3 was archived: the run's high-water mark still remembers it.
  assert.deepEqual(nextMemberId({ seq: 3, members: [{ id: "l1" }, { id: "l2" }] }), { id: "l4", seq: 4 });
  assert.deepEqual(nextMemberId({ members: [] }), { id: "l1", seq: 1 });
});

test("branches and checkouts", () => {
  const branch = laneBranch("fix-login-ab12", { variant: "B", index: 2, agent: { key: "claude-haiku" } });
  assert.equal(branch, "arena/fix-login-ab12/claude-haiku-2-b");
  assert.equal(worktreePath("/h/.herdr/worktrees", "app", branch), "/h/.herdr/worktrees/app/arena-fix-login-ab12-claude-haiku-2-b");
});

test("typed commands split like a shell", () => {
  assert.deepEqual(splitCommand(`claude --model haiku --append-system-prompt "be brief" ''`), ["claude", "--model", "haiku", "--append-system-prompt", "be brief", ""]);
});

test("in double quotes a backslash escapes only what the shell lets it", () => {
  assert.deepEqual(splitCommand(String.raw`x "use C:\tmp\x" "say \"hi\" \$HOME"`), ["x", String.raw`use C:\tmp\x`, `say "hi" $HOME`]);
  assert.deepEqual(splitCommand(String.raw`x 'C:\tmp' C:\\d`), ["x", String.raw`C:\tmp`, String.raw`C:\d`]);
});

test("setup commands run before the agent, which gets the task", () => {
  assert.deepEqual(laneArgv(["claude"], []), ["claude"]);
  const argv = laneArgv(["claude", "--model", "haiku"], ["npm ci", " "]);
  assert.equal(argv[0], "sh");
  assert.equal(argv[2], 'set -e\nnpm ci\nexec "$@"');
  assert.deepEqual(argv.slice(3), ["arena-setup", "claude", "--model", "haiku"]);
});

test("an agent that reads its argument as a folder gets the task with its flag", () => {
  assert.deepEqual(agentWithTask(["claude"], "hi"), { argv: ["claude"], task: "hi" });
  assert.deepEqual(agentWithTask(["opencode"], "hi"), { argv: ["opencode", "--prompt", "hi"], task: undefined });
  assert.deepEqual(agentWithTask(["/opt/bin/opencode", "--model", "x"], "hi"), { argv: ["/opt/bin/opencode", "--model", "x", "--prompt", "hi"], task: undefined });
  assert.deepEqual(agentWithTask(["opencode", "--prompt", "fixed"], "hi"), { argv: ["opencode", "--prompt", "fixed"], task: "hi" });
});

test("fusion works on code only when every lane has a worktree and something changed", () => {
  const changed = { files: 2 }, none = { files: 0 };
  assert.equal(fusionModeFor([{ hasWorktree: true, diff: changed }, { hasWorktree: true, diff: none }]), "code");
  assert.equal(fusionModeFor([{ hasWorktree: true, diff: none }, { hasWorktree: true, diff: none }]), "answers");
  assert.equal(fusionModeFor([{ hasWorktree: true, diff: changed }, { hasWorktree: false, diff: null }]), "answers");
  assert.equal(fusionModeFor([]), "answers");
});

test("diffs are read to inline only while their lines are few", () => {
  assert.equal(mightInlineDiffs(1600), true);
  assert.equal(mightInlineDiffs(1700), false);
});

test("a few very long lines don't pass for a small diff", () => {
  assert.equal(diffsFit(["+x\n".repeat(100)]), true);
  // One changed line of minified code: two lines by count, 600 KB by size.
  assert.equal(diffsFit(["-a\n+" + "y".repeat(600_000)]), false);
  assert.equal(diffsFit([]), true);
});

test("byte lengths count UTF-8", () => {
  assert.equal(utf8Length("aé€😀"), 1 + 2 + 3 + 4);
});

test("code fusion brings an attempt in with deletions, across the whole repo", () => {
  const text = codeInstructions("abc", 2);
  assert.match(text, /git restore --source=<snapshot> --staged --worktree -- :\//);
  assert.doesNotMatch(text, /checkout <snapshot> -- \./);
});

test("the answers prompt carries the task and every result", () => {
  const text = answersPrompt({ prompts: new Map([["A", "Explain X"]]), sources: [{ label: "Claude", reply: "one" }, { label: "Codex", reply: "two" }] });
  assert.match(text, /\[Task\]\nExplain X\n\[End of task\]/);
  assert.match(text, /\[Result 1 · Claude\]\none/);
  assert.match(text, /\[Result 2 · Codex\]\ntwo/);
});

test("the code prompt names the base, each snapshot and its changes", () => {
  const text = codePrompt({
    baseCommit: "abc123",
    prompts: new Map([["A", "Add retries"], ["B", "Add retries with backoff"]]),
    sources: [{ label: "Claude · A", reply: "done", snapshot: { commit: "s1", head: "abc123" }, diff: { files: 2, insertions: 10, deletions: 1 }, diffText: "diff --git" }],
  });
  assert.match(text, /fresh, checked out at abc123/);
  assert.match(text, /\[Task, variant B\]/);
  assert.match(text, /Snapshot: s1\nStarted at: abc123\nChanges: 2 files, \+10 −1/);
  assert.match(text, /Its diff:\ndiff --git/);
});

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join("\n");
const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const answer = (id, blocks, extra = {}) => ({ type: "assistant", message: { id, role: "assistant", content: blocks }, ...extra });

test("the last answer is the newest text message of the last turn", () => {
  const text = lastAnswer(jsonl(
    prompt("first"), answer("m1", [{ type: "text", text: "old" }]),
    prompt("second"),
    answer("m2", [{ type: "text", text: "Let me look." }]),
    answer("m2", [{ type: "tool_use", name: "Read" }]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    answer("m3", [{ type: "text", text: "Done." }]),
    answer("m3", [{ type: "text", text: "Tests pass." }]),
  ));
  assert.equal(text, "Done.\n\nTests pass.");
});

test("sub-agents, meta prompts and command output are not the answer or a turn", () => {
  const text = lastAnswer(jsonl(
    prompt("task"),
    answer("m1", [{ type: "text", text: "main" }]),
    answer("s1", [{ type: "text", text: "side" }], { isSidechain: true }),
    { type: "user", isMeta: true, message: { role: "user", content: "caveat" } },
    prompt("<local-command-stdout>ok</local-command-stdout>"),
  ));
  assert.equal(text, "main");
});

test("a turn without text yet, and no turn at all", () => {
  assert.equal(lastAnswer(jsonl(prompt("task"), answer("m1", [{ type: "tool_use" }]))), "");
  assert.equal(lastAnswer(""), null);
  assert.equal(lastAnswer('{"type":"assistant","message":{"content":[{"type":"text","text":"cut'), null);
});

test("screen tails drop trailing blank lines", () => {
  assert.equal(screenTail("a\nb  \n\n\n", 1), "b");
});

test("screen tails drop the agent's input line and the status lines under it", () => {
  const codex = "› merhaba\n• Merhaba! Nasıl yardımcı olabilirim?\n\n  Worked for 13s\n\n› Ask Codex to do anything\n\n  GPT · ~/app\n  ← for agents · ? for shortcuts\n";
  assert.equal(screenTail(codex), "› merhaba\n• Merhaba! Nasıl yardımcı olabilirim?\n\n  Worked for 13s");
  const boxed = "● Done.\n╭──────╮\n│ ❯    │\n╰──────╯\n  ? for shortcuts";
  assert.equal(screenTail(boxed), "● Done.");
  // An input line far above the bottom is part of the conversation.
  assert.equal(screenTail("› task\n1\n2\n3\n4\n5\n6\n7"), "› task\n1\n2\n3\n4\n5\n6\n7");
});

const codexItem = (item) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } });
const said = (text) => codexItem({ type: "UserMessage", content: [{ type: "text", text }] });
const answered = (text) => codexItem({ type: "AgentMessage", content: [{ type: "Text", text }] });

test("codex answers are the newest agent message of the last turn", () => {
  assert.equal(codexLastAnswer([said("hi"), answered("Hello!")].join("\n")), "Hello!");
  assert.equal(codexLastAnswer([said("hi"), answered("one"), answered("two")].join("\n")), "two");
  assert.equal(codexLastAnswer([said("hi"), answered("old"), said("again")].join("\n")), "");
  assert.equal(codexLastAnswer(JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } })), null);
  assert.equal(codexLastAnswer('{"type":"event_msg","payload":{"type":"item_compl'), null);
});

test("an opencode lane's session is the newest one in its folder since it started", () => {
  const list = JSON.stringify([
    { id: "ses_old", directory: "/w/lane", created: 50 },
    { id: "ses_other", directory: "/w/other", created: 300 },
    { id: "ses_new", directory: "/w/lane", created: 200 },
    { id: "ses_mid", directory: "/w/lane", created: 150 },
  ]);
  assert.equal(opencodeSessionFor(list, "/w/lane", 100), "ses_new");
  assert.equal(opencodeSessionFor(list, "/w/lane", 250), null);
  assert.equal(opencodeSessionFor("nope", "/w/lane", 0), null);
});

test("opencode answers are the text of the last turn, not its reasoning", () => {
  const user = (text) => ({ type: "user", text });
  const reply = (...content) => ({ type: "assistant", content });
  const out = (messages) => JSON.stringify({ info: {}, messages });
  assert.equal(opencodeLastAnswer(out([user("hi"), reply({ type: "reasoning", text: "think" }, { type: "text", text: "Merhaba!" }), { type: "idle" }])), "Merhaba!");
  assert.equal(opencodeLastAnswer(out([user("hi"), reply({ type: "text", text: "a" }), reply({ type: "tool" })])), "a");
  assert.equal(opencodeLastAnswer(out([user("hi"), reply({ type: "text", text: "old" }), user("again")])), "");
  assert.equal(opencodeLastAnswer(out([])), null);
  assert.equal(opencodeLastAnswer("not json"), null);
});

test("a codex rollout says where and when it began", () => {
  const line = JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T19:19:10.055Z", payload: { cwd: "/w/lane", timestamp: "2026-11-01T19:19:09.742Z" } });
  assert.deepEqual(codexSessionMeta(line), { cwd: "/w/lane", at: Date.parse("2026-11-01T19:19:09.742Z") });
  assert.equal(codexSessionMeta(said("hi")), null);
  assert.equal(codexSessionMeta("not json"), null);
});

test("claude project folders replace separators", () => {
  assert.equal(claudeProjectDir("/Users/me/.herdr/worktrees/app"), "-Users-me--herdr-worktrees-app");
  assert.equal(claudeProjectDir("/Users/me/my_service v2"), "-Users-me-my-service-v2");
});

test("numstat counts files, binary ones too", () => {
  assert.deepEqual(parseNumstat("3\t1\ta.js\n-\t-\tlogo.png\n10\t0\tb.js\n"), { files: 3, insertions: 13, deletions: 1 });
});

test("a lane is read again when its turn moves", () => {
  const sig = laneSig(live({ turn: 2 }), { status: "done" });
  assert.notEqual(sig, laneSig(live({ turn: 1 }), { status: "done" }));
  assert.equal(needsRead(undefined, sig, 0), true);
  assert.equal(needsRead({ sig: "old", at: 0, tries: 0, reply: { state: "ready", text: "x" } }, sig, 0), true);
  assert.equal(needsRead({ sig, at: 0, tries: 0, reply: { state: "ready", text: "x" } }, sig, 60_000), false);
});

test("an empty or failed read is tried again a few times, then taken as final", () => {
  const sig = "s";
  const empty = (tries, at) => ({ sig, at, tries, reply: { state: "ready", text: "" }, diff: null });
  assert.equal(needsRead(empty(0, 1000), sig, 1000 + READ_RETRY_MS - 1), false);
  assert.equal(needsRead(empty(0, 1000), sig, 1000 + READ_RETRY_MS), true);
  assert.equal(needsRead({ sig, at: 0, tries: 1, reply: { state: "error" } }, sig, READ_RETRY_MS), true);
  assert.equal(needsRead(empty(READ_RETRIES, 0), sig, 60_000), false);
  // A screen tail is as good as it gets for that agent: no retries.
  assert.equal(needsRead({ sig, at: 0, tries: 0, reply: { state: "ready", text: "", screen: true } }, sig, 60_000), false);
});

test("automatic fusion waits for reads of the current turn that won't change", () => {
  const sig = "s";
  assert.equal(readSettled(undefined, sig), false);
  assert.equal(readSettled({ sig: "before", tries: 0, reply: { state: "ready", text: "x" } }, sig), false);
  assert.equal(readSettled({ sig, tries: 0, reply: { state: "ready", text: "" } }, sig), false);
  assert.equal(readSettled({ sig, tries: READ_RETRIES, reply: { state: "ready", text: "" } }, sig), true);
  assert.equal(readSettled({ sig, tries: 0, reply: { state: "ready", text: "x" }, diff: { state: "ready" } }, sig), true);
});

test("removing a variant keeps the one being edited shown", () => {
  // A, B, C; editing B; remove A: B is now at 0.
  assert.equal(activeAfterRemoval(1, 0, 2), 0);
  // Editing B; remove C: B stays at 1.
  assert.equal(activeAfterRemoval(1, 2, 2), 1);
  // Editing C (the last); remove it: the new last.
  assert.equal(activeAfterRemoval(2, 2, 2), 1);
  assert.equal(activeAfterRemoval(0, 0, 1), 0);
});
