// Test-only (never bundled): fixture loading and frame builders for the panel's tests, over the
// hand-written fixtures in packages/contracts/fixtures/panel (also parsed by contracts'
// panelFixtures.test.ts).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type PanelPreviewChunk, type PanelResultItem, type PanelState, PanelStateSchema, type PreviewDescriptor } from "@scout/contracts";
import { CommandTracker, type PanelCommand } from "./commands.js";
import type { PanelModel } from "./model.js";
import { acceptAndVerify, type PreviewKey, sha256Hex } from "./preview.js";

export const FIXTURES_DIR = fileURLToPath(new URL("../../../contracts/fixtures/panel/", import.meta.url));

export const F = {
  rid: `res_${"a".repeat(64)}`,
  rid2: `res_${"b".repeat(64)}`,
  v1: "1".repeat(64),
  v2: "2".repeat(64),
  v3: "3".repeat(64),
  origin: "https://docs.example.com",
  /** A fixture file, parsed and validated as a PanelState. */
  frame(name: string): PanelState {
    return PanelStateSchema.parse(JSON.parse(readFileSync(FIXTURES_DIR + name, "utf8")));
  },
  raw(name: string): unknown {
    return JSON.parse(readFileSync(FIXTURES_DIR + name, "utf8"));
  },
  names(prefix: string): string[] {
    return readdirSync(FIXTURES_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort();
  },
};

/** Deterministic IDs: `<prefix>-1`, `<prefix>-2`, … */
export function counterIds(prefix = "t"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
export const tracker = (prefix = "t") => new CommandTracker(counterIds(prefix));

export function offer({ rid = F.rid, version = F.v1, origin = F.origin, revision = 1 } = {}) {
  return { resourceId: rid, version, kind: "llms_txt" as const, siteOrigin: origin, sourceUrl: `${origin}/llms.txt`, byteLength: 100, fetchedAt: 1, resourceRevision: revision };
}

export function entry({
  rid = F.rid,
  origin = F.origin,
  state = "approved" as "approved" | "blocked" | "no_default",
  defaultVersion = F.v2 as string | null,
  versions = [[F.v2, "approved"]] as Array<[string, "pending" | "approved" | "superseded" | "declined" | "revoked"]>,
  revision = 5,
} = {}) {
  return {
    resourceId: rid,
    kind: "llms_txt" as const,
    siteOrigin: origin,
    sourceUrl: `${origin}/llms.txt`,
    state,
    resourceRevision: revision,
    versions: versions.map(([hash, s]) => ({ hash, state: s, byteLength: 1, fetchedAt: 1 })),
    ...(defaultVersion !== null ? { defaultVersion } : {}),
  };
}

export function originSetting(origin = F.origin, { autoAcquire = false, permitted = true } = {}) {
  return { origin, autoAcquire, permitted };
}

export function capabilities({
  instance = "core-1",
  revision = 1,
  offers = [] as ReturnType<typeof offer>[],
  library = [] as ReturnType<typeof entry>[],
  origins = [] as ReturnType<typeof originSetting>[],
  conflicts = [] as Array<{ name: string; resourceId: string; code: "foreign_collision" | "left_modified" | "left_symlink" | "name_collision" | "io_error" }>,
  agents = undefined as { available: Array<{ id: string; label: string }>; current?: string } | undefined,
} = {}): PanelState {
  return PanelStateSchema.parse({ type: "capabilities", coreInstanceId: instance, revision, approvalRevision: 0, truncated: false, offers, library, conflicts, origins, ...(agents ? { agents } : {}) });
}

export type Outcome =
  | { status: "ok"; items: PanelResultItem[] }
  | { status: "empty" }
  | { status: "unavailable"; reason: "no_time_left" | "agent_unavailable" | "busy" }
  | { status: "error"; reason: "timeout" | "invalid_output" | "tool_unavailable" | "preflight_failed" | "unsupported_configuration" | "agent_failed" }
  | { status: "cancelled"; reason: "superseded" | "visit_changed" | "revoked" | "paused" | "shutdown" };

/** A `results` frame for core instance "core-1". */
export function results(epoch: number, outcome: Outcome, { job = "job-1", instance = "core-1", origin = F.origin } = {}): PanelState {
  return PanelStateSchema.parse({ type: "results", coreInstanceId: instance, visitEpoch: epoch, origin, jobId: job, ...outcome });
}

export function state(status: "idle" | "working" | "paused" | "disconnected", { epoch, detail, permitted, jobId }: { epoch?: number; detail?: string; permitted?: boolean; jobId?: string } = {}): PanelState {
  return {
    type: "state",
    status,
    ...(epoch !== undefined ? { visitEpoch: epoch } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(permitted !== undefined ? { permitted } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
  } as PanelState;
}

export const ackOk = (commandId: string, { revision = 0, approvalRevision = 0, target }: { revision?: number; approvalRevision?: number; target?: string } = {}): PanelState =>
  ({ type: "ack", commandId, ok: true, revision, approvalRevision, ...(target !== undefined ? { target: { href: target } } : {}) }) as PanelState;
export const ackFailed = (commandId: string, code: "stale_revision" | "not_found" | "invalid" | "store_error" | "not_permitted" | "unavailable", revision?: number): PanelState =>
  ({ type: "ack", commandId, ok: false, code, ...(revision !== undefined ? { revision } : {}) }) as PanelState;

export const descriptor: PreviewDescriptor = { kind: "llms_txt", siteOrigin: F.origin, sourceUrl: `${F.origin}/llms.txt` };

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** `text` cut into chunks of at most `size` bytes on code-point boundaries, as the core cuts it (commandId "x"). */
export function chunks(text: string, key: PreviewKey, size: number): PanelPreviewChunk[] {
  const bytes = new TextEncoder().encode(text);
  const sha = sha256(bytes);
  const out: PanelPreviewChunk[] = [];
  let offset = 0;
  do {
    let end = Math.min(offset + size, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const last = end >= bytes.length;
    const c: PanelPreviewChunk = {
      type: "preview",
      commandId: "x",
      resourceId: key.resourceId,
      version: key.version,
      seq: out.length,
      offset,
      totalBytes: bytes.length,
      text: new TextDecoder().decode(bytes.subarray(offset, end)),
      sha256: sha,
      descriptor,
    };
    if (!last) c.nextCursor = `cur${out.length + 1}`;
    out.push(c);
    offset = end;
  } while (offset < bytes.length);
  return out;
}

export const withId = (c: PanelPreviewChunk, commandId: string): PanelPreviewChunk => ({ ...c, commandId });

/** Applies `frame` and finishes any preview hash check, as panel-app does. Returns the commands. */
export async function applyVerified(model: PanelModel, frame: PanelState): Promise<PanelCommand[]> {
  const out = model.apply(frame);
  for (const a of model.previewsToVerify()) model.previewVerified(a.key, await sha256Hex(a.bytes));
  return out;
}

/** Answers `first` and each follow-up request with the next chunk. Returns every command the model sent. */
export async function answer(model: PanelModel, first: PanelCommand, with_: PanelPreviewChunk[]): Promise<PanelCommand[]> {
  let request: PanelCommand | undefined = first;
  const sent: PanelCommand[] = [];
  for (const c of with_) {
    if (!request) break;
    const more = await applyVerified(model, withId(c, request.commandId));
    sent.push(...more);
    request = more[0];
  }
  return sent;
}

export { acceptAndVerify };

/** Settings' agent choice as a core that found both test agents sends it. */
export const AGENTS = {
  available: [
    { id: "agent-a", label: "Agent A" },
    { id: "agent-b", label: "Agent B" },
  ],
  current: "agent-a",
};
