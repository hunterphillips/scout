// Turn the model's structured_output into a rank result the service can stand behind.
//
// The top level must be one of the two AgentOutput shapes (`{status:"empty"}` or
// `{status:"ok", items:[...]}`); anything else is a parse failure (`error`,
// `invalid_output`). Items are then checked one by one, so one bad pick never sinks the
// others: an item is dropped when its candidate id is unknown or repeated, when it has no
// string reason, a reason over 140 characters or a reason that cleans to nothing (only a
// URL, say), or when none of its evidence ids was issued by this run's source tools
// (a path, title or URL in place of an id is simply not an issued id). At most
// `maxResults` surviving items are kept; once that many survive, the rest are neither
// examined nor counted as dropped. Kept reasons have URL-like strings removed and are
// cut to 140 characters.
//
// The 140-character reason limit is checked in two places. The CLI's --json-schema
// (AGENT_OUTPUT_JSON_SCHEMA, maxLength 140) fires first, when the CLI honours it; the
// service does not parse the output with AgentOutputSchema, so the per-item check here is
// the service's own enforcement. Both count code points, as JSON Schema's maxLength does.
// An over-long reason drops that one item (counted in droppedCount), never the whole output,
// and is refused before cleanReason runs, so the regex never sees more than 140 characters. Evidence labels are written here from the audit map; any label, path
// or other extra field the model put on an item is never read.
//
// Outcomes: model `empty` -> `empty`; some items survived -> `ok` with `droppedCount`;
// items but none survived -> `error: validation_failed` with `droppedCount` (not an
// honest empty). `cancelled` and `unavailable` are never produced here.

import {
  EVIDENCE_ID_PATTERN,
  MAX_EVIDENCE_PER_ITEM,
  MAX_REASON_CHARS,
  type Evidence,
  type RankItem,
  type RankRequest,
} from "./api.js";
import type { AuditIndex } from "./auditIndex.js";
import type { EvidenceLocation } from "./sourceTools/evidence.js";

export interface RankOkResult {
  status: "ok";
  items: RankItem[];
  /**
   * Items the model returned that failed validation (unknown or repeated id, missing or
   * over-long or empty-after-cleaning reason, no issued evidence). Items past `maxResults` are cut, not dropped, and never counted.
   */
  droppedCount: number;
}
export interface RankEmptyResult {
  status: "empty";
}
export interface RankFailureResult {
  status: "unavailable" | "cancelled" | "error";
  reason: string;
  /** On `validation_failed`: items rejected by validation, as on RankOkResult. */
  droppedCount?: number;
}
/** A rank_site_links response without its ContextStatus fields (the server adds those). */
export type RankResult = RankOkResult | RankEmptyResult | RankFailureResult;

/** Parse failures: not one of the two AgentOutput shapes. */
export const INVALID_OUTPUT = "invalid_output";
export const VALIDATION_FAILED = "validation_failed";

/** Most items the service will even look at; a longer list is a parse failure. */
const MAX_ITEMS_EXAMINED = 64;
const MAX_LABEL_CHARS = 120;

export type LabelFor = (loc: EvidenceLocation) => string;

/**
 * Short service-written labels, never anything the model wrote. Labels may carry Hunter's
 * own page titles (the runner's activity labels) and relative note paths; never absolute
 * paths or snippet text.
 */
export const defaultLabelFor: LabelFor = (loc) => {
  if (loc.kind === "activity") return "recent page";
  if (loc.kind === "focus") return "focus item";
  return loc.path === undefined ? loc.sourceId : `${loc.sourceId}: ${loc.path}`;
};

const HOST_TLDS = "com|org|net|io|dev|ai|co|app|edu|gov";
/**
 * URL-like strings: `scheme://…`, `www.…`, a `javascript:`/`data:`/`mailto:`/`file:` word
 * followed by a non-space (so "config file: X" survives), a dotted name followed by a path
 * (`evil.example/x`), and a bare host ending in a common TLD (`evil.com`). "e.g.", "v1.2"
 * and note names like "README.md" are not URL-like.
 *
 * Every repeat before a required literal is bounded (a scheme of at most 32 characters,
 * host labels of 1-63 characters, at most 11 labels, a 63-character lookbehind), and a label never contains the
 * `.` that separates labels, so a failed match costs a bounded number of steps per start
 * position and a hostile reason such as "a-a-a-…" or "a.b-a.b-…" is scanned in linear time.
 * validateResponse also refuses reasons over 140 characters before this runs.
 */
const HOST_LABEL = String.raw`[\w-]{1,63}`;
const URL_LIKE = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9+.-]{0,31}:\/\/\S*`,
    String.raw`\bwww\.\S*`,
    String.raw`\b(?:javascript|data|mailto|file):(?=\S)\S*`,
    // One pass over the labels for both host forms: a common TLD, or a path whose `/`
    // follows at least one dot (the lookbehind), so "foo/bar" survives.
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
  return [...cleaned].slice(0, MAX_REASON_CHARS).join("").trim();
}

function cleanLabel(label: string): string {
  const flat = label
    .replace(/\p{Cc}|\p{Cf}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...flat].slice(0, MAX_LABEL_CHARS).join("");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const hasOnlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

export interface ValidateInput {
  /** The result envelope's structured_output, untrusted. */
  output: unknown;
  req: Pick<RankRequest, "candidates" | "maxResults">;
  audit: AuditIndex;
  labelFor?: LabelFor;
}

export function validateResponse({ output, req, audit, labelFor = defaultLabelFor }: ValidateInput): RankResult {
  if (!isRecord(output)) return { status: "error", reason: INVALID_OUTPUT };
  if (output.status === "empty") {
    return hasOnlyKeys(output, ["status"]) ? { status: "empty" } : { status: "error", reason: INVALID_OUTPUT };
  }
  if (output.status !== "ok" || !hasOnlyKeys(output, ["status", "items"])) return { status: "error", reason: INVALID_OUTPUT };
  const items = output.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_EXAMINED) return { status: "error", reason: INVALID_OUTPUT };

  const known = new Set(req.candidates.map((c) => c.id));
  const seen = new Set<string>();
  const kept: RankItem[] = [];
  let droppedCount = 0;
  for (const raw of items) {
    if (kept.length >= req.maxResults) break; // cut, not dropped: never examined or counted
    droppedCount++; // undone below once the item survives
    if (!isRecord(raw)) continue;
    const { id, reason, evidenceIds } = raw;
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id); // a repeat of this id is dropped even if this one fails below
    if (typeof reason !== "string" || !Array.isArray(evidenceIds)) continue;
    if (reason.length > 2 * MAX_REASON_CHARS || [...reason].length > MAX_REASON_CHARS) continue; // before cleanReason
    const evidence: Evidence[] = [];
    const cited = new Set<string>();
    for (const e of evidenceIds) {
      if (typeof e !== "string" || !EVIDENCE_ID_PATTERN.test(e) || cited.has(e)) continue;
      const loc = audit.evidence.get(e);
      if (loc === undefined) continue; // never issued in this run
      cited.add(e);
      evidence.push({ id: e, kind: loc.kind, label: cleanLabel(labelFor(loc)) });
      if (evidence.length >= MAX_EVIDENCE_PER_ITEM) break;
    }
    if (evidence.length === 0) continue;
    const cleaned = cleanReason(reason);
    if (cleaned === "") continue; // nothing left once URLs are removed
    kept.push({ id, reason: cleaned, evidence });
    droppedCount--;
  }
  if (kept.length === 0) return { status: "error", reason: VALIDATION_FAILED, droppedCount };
  return { status: "ok", items: kept, droppedCount };
}
