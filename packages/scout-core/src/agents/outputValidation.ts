// Turn a job's structured output into picks Scout can stand behind.
//
// Top level: exactly `{status:"empty"}` or `{status:"ok", items:[1..JOB_MAX_PICKS]}`
// (JobAgentOutputSchema's shapes, checked here field by field so one bad item does not sink
// the others). Anything else, including too many items, is `invalid_output`.
//
// Items: an item is dropped when its ID is not a string matching the candidate pattern,
// is not in this request's candidate list, or repeats an earlier item; when it has extra
// keys; or when its reason is missing, over JOB_REASON_MAX_CHARS code points, or empty once
// URL-like text is removed. Valid items past `maxPicks` are cut, not dropped.
//
// Outcomes: the model's `empty` -> `empty`. Some items survive -> `ok` with the dropped
// count. Items, none survive -> `invalid_output`, never `empty`: an invalid answer is not
// an honest "nothing fits".
//
// Provenance: cleanReason and its URL_LIKE pattern are copied verbatim from
// packages/personal-context-mcp/src/validateResponse.ts, removed in P4.4 (git history has
// it; outputValidation.test.ts pins the legacy results). The rest is new: no evidence IDs, labels or
// audit map, which belonged to the legacy service's personal sources.

import { JOB_MAX_PICKS, JOB_REASON_MAX_CHARS, type AgentPick, type JobRequest } from "@scout/contracts";

const CANDIDATE_ID_RE = /^c[0-9a-z]{1,31}$/;

export type ValidatedOutput =
  | { status: "ok"; items: AgentPick[]; droppedPicks: number; cutPicks: number }
  | { status: "empty" }
  | { status: "invalid"; droppedPicks: number };

const HOST_TLDS = "com|org|net|io|dev|ai|co|app|edu|gov";
/**
 * URL-like strings: `scheme://…`, `www.…`, a `javascript:`/`data:`/`mailto:`/`file:` word
 * followed by a non-space, a dotted name followed by a path, and a bare host ending in a
 * common TLD. Every repeat before a required literal is bounded, so a hostile reason is
 * scanned in linear time; reasons over the cap are refused before this runs.
 */
const HOST_LABEL = String.raw`[\w-]{1,63}`;
const URL_LIKE = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9+.-]{0,31}:\/\/\S*`,
    String.raw`\bwww\.\S*`,
    String.raw`\b(?:javascript|data|mailto|file):(?=\S)\S*`,
    String.raw`\b${HOST_LABEL}(?:\.${HOST_LABEL}){0,10}(?:\.(?:${HOST_TLDS})(?![\w-])|\/(?<=\.${HOST_LABEL}\/))\S*`,
  ].join("|"),
  "giu",
);

/** Remove URL-like strings, control and format characters; collapse whitespace; cap at 140 characters. */
export function cleanReason(reason: string): string {
  const cleaned = reason
    .replace(/\p{Cc}|\p{Cf}/gu, " ")
    .replace(URL_LIKE, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, JOB_REASON_MAX_CHARS).join("").trim();
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOnlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

export function validateJobOutput(output: unknown, req: Pick<JobRequest, "candidates" | "maxPicks">): ValidatedOutput {
  const invalid = (droppedPicks = 0): ValidatedOutput => ({ status: "invalid", droppedPicks });
  if (!isRecord(output)) return invalid();
  if (output.status === "empty") return hasOnlyKeys(output, ["status"]) ? { status: "empty" } : invalid();
  if (output.status !== "ok" || !hasOnlyKeys(output, ["status", "items"])) return invalid();
  const items = output.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > JOB_MAX_PICKS) return invalid();

  const known = new Set(req.candidates.map((c) => c.id));
  const seen = new Set<string>();
  const kept: AgentPick[] = [];
  let droppedPicks = 0;
  let cutPicks = 0;
  for (const raw of items) {
    const pick = checkItem(raw, known, seen);
    if (pick === undefined) droppedPicks++;
    else if (kept.length >= req.maxPicks) cutPicks++;
    else kept.push(pick);
  }
  if (kept.length === 0) return invalid(droppedPicks);
  return { status: "ok", items: kept, droppedPicks, cutPicks };
}

function checkItem(raw: unknown, known: ReadonlySet<string>, seen: Set<string>): AgentPick | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, reason } = raw;
  if (typeof id !== "string" || !CANDIDATE_ID_RE.test(id) || !known.has(id) || seen.has(id)) return undefined;
  seen.add(id); // a repeat of this id is dropped even if this one fails below
  if (!hasOnlyKeys(raw, ["id", "reason"]) || typeof reason !== "string") return undefined;
  if (reason.length > 2 * JOB_REASON_MAX_CHARS || [...reason].length > JOB_REASON_MAX_CHARS) return undefined; // before the regex
  const cleaned = cleanReason(reason);
  return cleaned === "" ? undefined : { id, reason: cleaned };
}
