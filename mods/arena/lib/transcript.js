// A lane's latest answer. Claude Code writes a JSONL transcript; Arena reads
// its tail. Other agents have no transcript Arena knows, so their card shows
// the end of the terminal screen instead, marked as such.

/** Claude Code names a project folder after its cwd, every character but letters and digits as "-". */
export const claudeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const isPrompt = (record) => {
  if (record?.type !== "user" || record.isSidechain || record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === "string") return !/^\s*<(command-name|local-command-stdout|local-command-caveat)>/.test(content);
  return Array.isArray(content) && content.some((block) => block?.type === "text");
};

const textOf = (record) => {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n");
};

/**
 * The last answer of the last turn: the text of the newest assistant message
 * that has any, after the newest prompt. Claude Code writes one record per
 * content block, so the records sharing that message's id are joined.
 * Returns "" when the turn has no text yet, and null without any turn.
 *
 * @param {string} jsonl
 * @returns {string | null}
 */
export function lastAnswer(jsonl) {
  const records = [];
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a line cut by tail, or one being written */ }
  }
  let start = -1;
  for (let i = records.length - 1; i >= 0; i--) if (isPrompt(records[i])) { start = i; break; }
  const turn = records.slice(start + 1).filter((r) => r?.type === "assistant" && !r.isSidechain);
  if (start < 0 && turn.length === 0) return null;
  let last = -1;
  for (let i = turn.length - 1; i >= 0; i--) if (textOf(turn[i]).trim()) { last = i; break; }
  if (last < 0) return "";
  const id = turn[last].message?.id;
  const parts = [];
  for (let i = last; i >= 0; i--) {
    const record = turn[i];
    if (id ? record.message?.id !== id : i !== last) break;
    const text = textOf(record);
    if (text.trim()) parts.unshift(text);
  }
  return parts.join("\n\n").trim();
}

/** The end of a screen, without trailing blank lines or prompt chrome: what a card can show. */
export function screenTail(text, lines = 24) {
  const rows = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.slice(-lines).join("\n").trim();
}
