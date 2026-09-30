// The evidence map one run's source-tools server issued, read back from
// <runDir>/audit.jsonl after the run. Only ids from `ok` call lines count: a refused or
// failed call commits no ids, so anything else was never shown to the model.

import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import { EVIDENCE_ID_PATTERN } from "./api.js";
import type { EvidenceKind, EvidenceLocation } from "./sourceTools/evidence.js";

/** Largest audit file the runner reads (20 calls of metadata is far below this). */
export const MAX_AUDIT_BYTES = 4 * 1024 * 1024;

export interface AuditIndex {
  /** evidenceId -> location, for every id an `ok` call issued. */
  readonly evidence: ReadonlyMap<string, EvidenceLocation>;
  /** Call lines of any status. */
  readonly toolCalls: number;
  /** Distinct source ids that issued evidence, sorted. */
  readonly sourceIds: readonly string[];
}

export const EMPTY_AUDIT: AuditIndex = Object.freeze({ evidence: new Map(), toolCalls: 0, sourceIds: Object.freeze([]) });

const KINDS: ReadonlySet<string> = new Set<EvidenceKind>(["activity", "note", "focus"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseLocation(e: unknown): [string, EvidenceLocation] | undefined {
  if (!isRecord(e)) return undefined;
  const { id, kind, sourceId, path, lines } = e;
  if (typeof id !== "string" || !EVIDENCE_ID_PATTERN.test(id)) return undefined;
  if (typeof kind !== "string" || !KINDS.has(kind) || typeof sourceId !== "string") return undefined;
  const loc: EvidenceLocation = { kind: kind as EvidenceKind, sourceId };
  if (typeof path === "string") loc.path = path;
  if (Array.isArray(lines) && lines.length === 2 && lines.every((n) => Number.isInteger(n))) loc.lines = [lines[0] as number, lines[1] as number];
  return [id, loc];
}

/** Parse audit.jsonl text. Unparseable lines are skipped. */
export function parseAuditIndex(text: string): AuditIndex {
  const evidence = new Map<string, EvidenceLocation>();
  let toolCalls = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec) || rec.type !== "call") continue;
    toolCalls++;
    if (rec.status !== "ok" || !Array.isArray(rec.evidence)) continue;
    for (const e of rec.evidence) {
      const parsed = parseLocation(e);
      if (parsed && !evidence.has(parsed[0])) evidence.set(parsed[0], Object.freeze(parsed[1]));
    }
  }
  const sourceIds = Object.freeze([...new Set([...evidence.values()].map((l) => l.sourceId))].sort());
  return Object.freeze({ evidence, toolCalls, sourceIds });
}

/** Read <path> without following a symlink, at most MAX_AUDIT_BYTES. Missing or unreadable: empty. */
export function readAuditIndex(path: string): AuditIndex {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return EMPTY_AUDIT;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_AUDIT_BYTES) return EMPTY_AUDIT;
    const buf = Buffer.alloc(MAX_AUDIT_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > MAX_AUDIT_BYTES) return EMPTY_AUDIT;
    }
    return parseAuditIndex(buf.subarray(0, len).toString("utf8"));
  } catch {
    return EMPTY_AUDIT;
  } finally {
    closeSync(fd);
  }
}
