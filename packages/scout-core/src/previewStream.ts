// Serves `preview` commands from Scout's window: one version's stored text in chunks of at most
// PREVIEW_CHUNK_MAX_BYTES, cut on UTF-8 boundaries, one chunk per command. Each chunk carries the
// full blob's SHA-256, its byte offset and total, the version's descriptor, and (unless it is
// the last) an opaque cursor for the next chunk. The app assembles and checks the chunks; it
// never sends text back.
//
// Any recorded version may be previewed, pending ones included (that is how the user decides),
// except while the resource is blocked or the version is revoked (`unavailable`). An unknown
// resource or version is `not_found`, and so is an unknown or expired cursor; a cursor presented
// for another resource or version is `invalid`.
//
// A multi-chunk read is one chain: its first chunk draws a pin ID and pins the version in the
// store (store.pinForPreview) so collection cannot drop it mid-read. The pin is released on the
// last chunk, when the chain expires (PREVIEW_CURSOR_TTL_MS after its latest chunk; swept on
// every command and by `sweepExpired`), when MAX_PREVIEW_CHAINS is exceeded (least recently used first), and
// on `close`. A revocation drops the store's pins itself and stops the next chunk. Cursors are
// not consumed, so a command the app retries gets the same chunk again.

import { randomBytes } from "node:crypto";
import {
  PREVIEW_CHUNK_MAX_BYTES,
  PREVIEW_CURSOR_TTL_MS,
  type AckFailureCode,
  type PanelPreviewChunk,
  type PreviewCommand,
  type PreviewDescriptor,
} from "@scout/contracts";
import { utf8Cut } from "./agentApi/handlers.js";
import type { CapabilityStore } from "./capabilities/store.js";
import type { Clock } from "./clock.js";

/** Open multi-chunk reads at once; the oldest is dropped beyond this. */
export const MAX_PREVIEW_CHAINS = 16;

export type PreviewStore = Pick<CapabilityStore, "getResource" | "readBlob" | "pinForPreview" | "releasePins">;

export type PreviewAnswer = { ok: true; chunk: PanelPreviewChunk } | { ok: false; code: AckFailureCode; revision?: number };

export interface PreviewStreamOptions {
  store: PreviewStore;
  clock: Clock;
  ttlMs?: number;
  chunkBytes?: number;
  maxChains?: number;
}

export interface PreviewStream {
  serve(cmd: PreviewCommand): PreviewAnswer;
  /** End expired chains and release their pins. */
  sweepExpired(): void;
  /** End every chain and release every pin. */
  close(): void;
  readonly openChains: number;
}

interface Chain {
  pinId: string;
  resourceId: string;
  version: string;
  expiresAt: number;
  cursors: Set<string>;
}

interface CursorState {
  pinId: string;
  offset: number;
  seq: number;
}

export function createPreviewStream(options: PreviewStreamOptions): PreviewStream {
  const { store, clock } = options;
  const ttlMs = options.ttlMs ?? PREVIEW_CURSOR_TTL_MS;
  const chunkBytes = options.chunkBytes ?? PREVIEW_CHUNK_MAX_BYTES;
  const maxChains = options.maxChains ?? MAX_PREVIEW_CHAINS;
  /** pinId -> chain, in creation order. */
  const chains = new Map<string, Chain>();
  const cursors = new Map<string, CursorState>();

  const endChain = (pinId: string): void => {
    const chain = chains.get(pinId);
    if (!chain) return;
    chains.delete(pinId);
    for (const c of chain.cursors) cursors.delete(c);
    store.releasePins(pinId);
  };

  const sweepExpired = (): void => {
    const now = clock.now();
    for (const chain of [...chains.values()]) if (chain.expiresAt <= now) endChain(chain.pinId);
  };

  const newId = () => randomBytes(16).toString("base64url");

  function serve(cmd: PreviewCommand): PreviewAnswer {
    sweepExpired();
    let offset = 0;
    let seq = 0;
    let chain: Chain | undefined;
    if (cmd.cursor !== undefined) {
      const c = cursors.get(cmd.cursor);
      chain = c && chains.get(c.pinId);
      if (!c || !chain) return { ok: false, code: "not_found" };
      if (chain.resourceId !== cmd.resourceId || chain.version !== cmd.version) return { ok: false, code: "invalid" };
      offset = c.offset;
      seq = c.seq;
    }
    const fail = (code: AckFailureCode, revision?: number): PreviewAnswer => {
      if (chain) endChain(chain.pinId);
      return revision === undefined ? { ok: false, code } : { ok: false, code, revision };
    };

    const r = store.getResource(cmd.resourceId);
    if (!r) return fail("not_found");
    const v = r.resource.versions.find((x) => x.hash === cmd.version);
    if (r.resource.blocked || v?.state === "revoked") return fail("unavailable", r.revision);
    if (!v) return fail("not_found", r.revision);
    let bytes: Buffer;
    try {
      bytes = store.readBlob(v.blobRef);
    } catch {
      return fail("unavailable", r.revision);
    }
    if (offset > bytes.length) return fail("invalid", r.revision);

    const end = utf8Cut(bytes, offset, chunkBytes);
    const meta = r.meta[v.hash];
    const descriptor: PreviewDescriptor = {
      kind: r.resource.kind,
      siteOrigin: r.resource.siteOrigin,
      sourceUrl: r.resource.sourceUrl,
      ...(meta?.contentType !== undefined ? { contentType: meta.contentType } : {}),
      ...(meta?.skill
        ? { skill: { name: meta.skill.name, ...(meta.skill.description !== undefined ? { description: meta.skill.description } : {}) } }
        : {}),
    };
    const chunk: PanelPreviewChunk = {
      type: "preview",
      commandId: cmd.commandId,
      resourceId: r.resource.id,
      version: v.hash,
      seq,
      offset,
      totalBytes: bytes.length,
      text: bytes.subarray(offset, end).toString("utf8"),
      // The blob is content-addressed and readBlob re-hashes it, so its name is its SHA-256.
      sha256: v.blobRef,
      descriptor,
    };
    if (end >= bytes.length) {
      if (chain) endChain(chain.pinId);
      return { ok: true, chunk };
    }

    chain ??= { pinId: newId(), resourceId: r.resource.id, version: v.hash, expiresAt: 0, cursors: new Set() };
    // Most recently used last, so eviction drops the chain idle longest.
    chains.delete(chain.pinId);
    chains.set(chain.pinId, chain);
    // Re-pinned on every chunk: a no-op unless something released the pin meanwhile.
    if (!store.pinForPreview(chain.pinId, r.resource.id, v.hash)) return fail("unavailable", r.revision);
    chain.expiresAt = clock.now() + ttlMs;
    const next = newId();
    chain.cursors.add(next);
    cursors.set(next, { pinId: chain.pinId, offset: end, seq: seq + 1 });
    while (chains.size > maxChains) endChain(chains.keys().next().value!);
    return { ok: true, chunk: { ...chunk, nextCursor: next } };
  }

  return {
    serve,
    sweepExpired,
    close() {
      for (const pinId of [...chains.keys()]) endChain(pinId);
    },
    get openChains() {
      return chains.size;
    },
  };
}
