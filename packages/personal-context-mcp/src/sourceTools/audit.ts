// <runDir>/audit.jsonl: one line per tool call plus lifecycle lines. Append-only, 0600,
// never through a symlink. It holds the evidence map (id -> source, path, lines) and
// metadata: tool name, a hash of the arguments, status, fixed codes, bytes and time. It
// never holds snippet or note text, queries, paths the model asked for, or URLs.

import { createHash } from "node:crypto";
import { closeSync, constants as fsc, openSync, writeSync } from "node:fs";
import type { Clock } from "../clock.js";
import type { EvidenceRecord } from "./evidence.js";

export type CallStatus = "ok" | "error" | "unavailable" | "budget_exhausted";

export interface CallAuditRecord {
  tool: string;
  args: unknown;
  status: CallStatus;
  /** A fixed code for `error` / `unavailable`. */
  code?: string;
  evidence: readonly EvidenceRecord[];
  bytes: number;
  ms: number;
}

export interface AuditLog {
  readonly path: string;
  /** Append one call line. Throws when the line can't be written. */
  call(rec: CallAuditRecord): void;
  /** Append one lifecycle line (`start`, `exit`). Throws when the line can't be written. */
  lifecycle(event: "start" | "exit", reason?: string): void;
}

/** JSON with object keys sorted at every depth, so equal arguments hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** sha256 of the canonical arguments, 16 hex characters. */
export function argsHash(args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(args ?? {}))
    .digest("hex")
    .slice(0, 16);
}

export function createAuditLog(path: string, clock: Clock, pid: number = process.pid): AuditLog {
  let seq = 0;
  const append = (obj: Record<string, unknown>): void => {
    const fd = openSync(path, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, JSON.stringify(obj) + "\n");
    } finally {
      closeSync(fd);
    }
  };
  const t = (): string => new Date(clock.now()).toISOString();
  return {
    path,
    call(rec) {
      const line: Record<string, unknown> = {
        t: t(),
        type: "call",
        seq: ++seq,
        tool: rec.tool,
        argsHash: argsHash(rec.args),
        status: rec.status,
        evidence: rec.evidence.map((e) => {
          const out: Record<string, unknown> = { id: e.id, kind: e.kind, sourceId: e.sourceId };
          if (e.path !== undefined) out.path = e.path;
          if (e.lines !== undefined) out.lines = e.lines;
          return out;
        }),
        bytes: rec.bytes,
        ms: rec.ms,
      };
      if (rec.code !== undefined) line.code = rec.code;
      append(line);
    },
    lifecycle(event, reason) {
      const line: Record<string, unknown> = { t: t(), type: "lifecycle", event, pid };
      if (reason !== undefined) line.reason = reason;
      append(line);
    },
  };
}
