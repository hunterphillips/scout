// Pure classifiers for the hot-load check: what one turn's events show, and which outcome
// class they add up to. No I/O. The analysis keeps evidence only: booleans, counts, Scout's
// own names (`scout-proof-*`, Skill, ToolSearch, the proof server's tools) and fixed codes.
// Model text is never kept, because it can name the user's other skills and servers.

import { usageOf } from "./report.mjs";

/** Read errors that mean the proof server's tool never became callable. */
export const NOT_LOADED_READ_ERRORS = Object.freeze(["tool_unavailable", "server_not_connected"]);

const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("\n") : "");

/** A failed read's code: Scout's own (`Scout <code>: ...`), else a coarse CLI-side class. */
export function readErrorCode(text) {
  const scout = /^Scout ([a-z_]+):/.exec(text ?? "");
  if (scout) return scout[1];
  if (/permission|not allowed|denied/i.test(text ?? "")) return "permission_denied";
  if (/not connected|still connecting|pending|failed to connect/i.test(text ?? "")) return "server_not_connected";
  if (/no such tool|not available|unknown tool/i.test(text ?? "")) return "tool_unavailable";
  return "tool_error";
}

/** Proof-skill names on the model's own "Skills seen:" line (any assistant text this turn). */
export function listedSkillNames(text) {
  const line = /^[^\S\n]*[*_]*Skills seen:[*_]*[^\S\n]*(.*)$/im.exec(text ?? "");
  return { lineFound: !!line, names: line ? [...new Set(line[1].match(/scout-proof-[a-z0-9]+/g) ?? [])] : [] };
}

/**
 * What one turn shows. Tool uses are named only when they are Skill (with the skill shown as
 * the proof name or `other`), ToolSearch, or the proof server's tools; the rest are counted
 * in otherToolUses.
 */
export function analyzeTurn(turn, { name, readTool, proofPhrase }) {
  const uses = [];
  const results = new Map();
  const texts = [];
  for (const ev of turn.events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (ev.type === "assistant" && b?.type === "tool_use") uses.push({ id: b.id, name: b.name, skill: b.input?.skill });
      if (ev.type === "assistant" && b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      if (ev.type === "user" && b?.type === "tool_result") results.set(b.tool_use_id, { isError: b.is_error === true, text: resultText(b.content) });
    }
  }
  const ours = (u) => u.name === "Skill" || u.name === "ToolSearch" || u.name === readTool || u.name === `mcp__${name}__list_resources`;
  const label = (u) => (u.name === "Skill" ? `Skill(${u.skill === name ? name : "other"})` : u.name);
  const skillUses = uses.filter((u) => u.name === "Skill" && u.skill === name);
  const reads = uses.filter((u) => u.name === readTool);
  const readResults = reads.map((u) => results.get(u.id));
  const readSucceeded = readResults.some((r) => r && !r.isError);
  let readError;
  if (!reads.length) readError = "not_called";
  else if (!readSucceeded) {
    const last = readResults.findLast(Boolean);
    readError = last ? readErrorCode(last.text) : "no_result";
  }
  const finalText = typeof turn.result?.result === "string" ? turn.result.result : (texts.at(-1) ?? "");
  const listing = listedSkillNames([...texts, finalText].join("\n"));
  return {
    ms: turn.ms,
    completed: !!turn.result && !turn.timedOut,
    timedOut: turn.timedOut,
    sessionExited: turn.exited,
    resultSubtype: typeof turn.result?.subtype === "string" && /^[a-z_]{1,40}$/.test(turn.result.subtype) ? turn.result.subtype : undefined,
    resultIsError: turn.result?.is_error === true,
    toolUses: uses.filter(ours).map((u) => ({ name: label(u), error: results.get(u.id)?.isError ?? null })),
    otherToolUses: uses.filter((u) => !ours(u)).length,
    toolSearchUses: uses.filter((u) => u.name === "ToolSearch").length,
    listingLineFound: listing.lineFound,
    listedNames: listing.names,
    discovery: listing.names.includes(name) ? "listed" : "not_listed",
    skillInvoked: skillUses.length > 0,
    skillSucceeded: skillUses.some((u) => results.get(u.id) && !results.get(u.id).isError),
    readCalled: reads.length > 0,
    readSucceeded,
    ...(readError ? { readError } : {}),
    readRevoked: readResults.some((r) => r?.isError && /\brevoked\b/.test(r.text)),
    proofPhraseQuoted: finalText.includes(proofPhrase),
    usage: usageOf(turn.result),
  };
}

/** The outcome class of a "use the skill" turn (see OUTCOMES in hotload.mjs). */
export function classifyUse(a) {
  if (!a.skillInvoked) return "skill_not_invoked";
  if (!a.readSucceeded) return "skill_invoked_read_failed";
  if (!a.proofPhraseQuoted) return "read_ok_phrase_missing";
  return a.discovery === "listed" ? "hotload_pass" : "skill_used_not_listed";
}

/**
 * Turn 2's outcome given the proof server's state at init. When the server was not usable at
 * init (pending, or connected without tools) and turn 2 shows it never became callable (the
 * read failed as unavailable/not connected, or the skill was invoked but no read was made),
 * the outcome is `mcp_not_loaded`.
 */
export function classifyTurn2(a, mcp) {
  const outcome = classifyUse(a);
  if (mcp.usable) return outcome;
  if (a.readCalled && !a.readSucceeded && NOT_LOADED_READ_ERRORS.includes(a.readError)) return "mcp_not_loaded";
  if (a.skillInvoked && a.readError === "not_called") return "mcp_not_loaded";
  return outcome;
}

/**
 * The proof server's state in an init summary. `atInit` is its status there, or
 * `connected_without_tools`. `proceed`: worth a turn 2 (connected, or still pending, or listed
 * without tools); otherwise (failed, absent, ...) not timing, so the check stops.
 */
export function proofServerState(initSummary, { name, readTool }) {
  const server = initSummary?.mcpServers?.find((s) => s.name === name);
  const status = server?.status ?? "absent";
  const toolsListed = !!initSummary?.tools?.includes(readTool);
  const toolSearchOffered = !!initSummary?.tools?.includes("ToolSearch");
  const atInit = status === "connected" && !toolsListed ? "connected_without_tools" : status;
  return { status, atInit, toolsListed, toolSearchOffered, usable: status === "connected" && toolsListed, proceed: status === "connected" || status === "pending" };
}

/** A fixed error code for a report: `error_<errno or name>`, identifier characters only. */
export function errorCode(e) {
  const raw = e?.code ?? e?.name;
  return `error_${typeof raw === "string" && /^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : "unknown"}`;
}
