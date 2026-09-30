// The two files the agent runner writes into a run dir before it starts the source-tools
// server: `snapshot.json` (the activity list copied at request time, the candidate count,
// the run's budgets) and `sources.json` (the enabled sources). Both are parsed strictly;
// any problem is a RunFileError with a fixed code and the server never starts serving.

import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  MAX_CANDIDATES,
  MAX_OBSERVATION_TITLE_CHARS,
  MAX_OBSERVATION_URL_CHARS,
  MAX_OBSERVED_AT_CHARS,
  MAX_SENSOR_CHARS,
} from "../api.js";
import { SourceConfigSchema, type SourceConfig } from "../config.js";
import { OBSERVATION_MAX_TEXT_BYTES } from "../observationStore.js";

/** The run budget across all tools (plan: 20 calls, 128 KiB returned). A snapshot may set lower. */
export const MAX_RUN_CALLS = 20;
export const MAX_RUN_BYTES = 128 * 1024;
/** Largest run file the server reads. */
export const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;
/** Most observations a snapshot may carry (the store keeps 10 by default). */
export const MAX_SNAPSHOT_OBSERVATIONS = 50;
/** Most sources a sources.json may list. */
export const MAX_RUN_SOURCES = 64;

export const SNAPSHOT_FILE = "snapshot.json";
export const SOURCES_FILE = "sources.json";
export const AUDIT_FILE = "audit.jsonl";

/** One stored observation as the observation store's snapshot() returns it. */
export const SnapshotObservationSchema = z.strictObject({
  observationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  sensor: z.string().min(1).max(MAX_SENSOR_CHARS),
  kind: z.literal("viewed_page"),
  observedAt: z.string().min(1).max(MAX_OBSERVED_AT_CHARS),
  url: z.string().min(1).max(MAX_OBSERVATION_URL_CHARS),
  title: z.string().max(MAX_OBSERVATION_TITLE_CHARS),
  // The store caps text at 8 KiB of UTF-8, so never more than 8 Ki characters.
  text: z.string().max(OBSERVATION_MAX_TEXT_BYTES).optional(),
  truncated: z.boolean(),
});

export const RunSnapshotSchema = z.strictObject({
  /** Newest first, as the store's snapshot() lists them. */
  observations: z.array(SnapshotObservationSchema).max(MAX_SNAPSHOT_OBSERVATIONS),
  candidateCount: z.int().min(0).max(MAX_CANDIDATES),
  budgets: z.strictObject({
    maxCalls: z.int().min(1).max(MAX_RUN_CALLS),
    maxTotalBytes: z.int().min(1).max(MAX_RUN_BYTES),
  }),
});

export const RunSourcesSchema = z.strictObject({
  sources: z.array(SourceConfigSchema).max(MAX_RUN_SOURCES),
});

export type SnapshotObservation = z.infer<typeof SnapshotObservationSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export interface RunFiles {
  snapshot: RunSnapshot;
  /** Enabled sources only; any `enabled: false` entry in the file is dropped. */
  sources: SourceConfig[];
}

export type RunFileErrorCode = "snapshot-unreadable" | "snapshot-invalid" | "sources-unreadable" | "sources-invalid";

export class RunFileError extends Error {
  constructor(readonly code: RunFileErrorCode) {
    super(code);
    this.name = "RunFileError";
  }
}

/** Read a regular file without following a symlink, at most MAX_RUN_FILE_BYTES. */
function readBounded(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RUN_FILE_BYTES) return undefined;
    const buf = Buffer.alloc(MAX_RUN_FILE_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > MAX_RUN_FILE_BYTES) return undefined;
    }
    return buf.subarray(0, len).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function readJson(path: string, unreadable: RunFileErrorCode, invalid: RunFileErrorCode): unknown {
  const raw = readBounded(path);
  if (raw === undefined) throw new RunFileError(unreadable);
  try {
    return JSON.parse(raw);
  } catch {
    throw new RunFileError(invalid); // the parse error may quote content: dropped
  }
}

/** Every source location must already be absolute (the runner writes resolved config). */
function sourcePathsAbsolute(s: SourceConfig): boolean {
  if (s.kind === "markdown_dir") return isAbsolute(s.root);
  if (s.kind === "registry_projects") return isAbsolute(s.registry);
  return true;
}

export function parseRunSnapshot(value: unknown): RunSnapshot {
  const r = RunSnapshotSchema.safeParse(value);
  if (!r.success) throw new RunFileError("snapshot-invalid");
  return r.data;
}

export function parseRunSources(value: unknown): SourceConfig[] {
  const r = RunSourcesSchema.safeParse(value);
  if (!r.success) throw new RunFileError("sources-invalid");
  const ids = r.data.sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new RunFileError("sources-invalid");
  if (!r.data.sources.every(sourcePathsAbsolute)) throw new RunFileError("sources-invalid");
  return r.data.sources.filter((s) => s.enabled);
}

/** Read and validate both run files. Throws RunFileError. */
export function readRunFiles(runDir: string): RunFiles {
  const snapshot = parseRunSnapshot(readJson(join(runDir, SNAPSHOT_FILE), "snapshot-unreadable", "snapshot-invalid"));
  const sources = parseRunSources(readJson(join(runDir, SOURCES_FILE), "sources-unreadable", "sources-invalid"));
  return { snapshot, sources };
}
