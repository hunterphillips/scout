// Builds one version's text from its `preview` chunks. A port of ScoutKit's PreviewAssembler.
// Chunks must arrive in `seq` order, each starting where the last ended, with the same
// `totalBytes`, blob hash and descriptor; the last one (no `nextCursor`) must end exactly at
// `totalBytes`. Any violation fails the preview for good; the user restarts it from the first chunk.
//
// The browser difference: SHA-256 comes from WebCrypto, which is asynchronous. After the last
// chunk the preview is `verifying`; `verified(digest)` (the hex SHA-256 of `bytes`, see
// sha256Hex) makes it `complete` or fails it as `hashMismatch`. Only a complete preview may be
// approved, exactly as in the app. Pure: no `chrome.*`.

import type { AckFailureCode, PanelPreviewChunk, PreviewDescriptor } from "@scout/contracts";
import type { PanelRequest } from "./commands.js";

/** `PREVIEW_CHUNK_MAX_BYTES` and `RESOURCE_MAX_BYTES` in @scout/contracts (pinned by a test). */
export const PREVIEW_CHUNK_MAX_BYTES = 16 * 1024;
export const RESOURCE_MAX_BYTES = 128 * 1024;

export interface PreviewKey {
  readonly resourceId: string;
  readonly version: string;
}

export const keyId = (k: PreviewKey): string => `${k.resourceId}/${k.version}`;
export const sameKey = (a: PreviewKey | null | undefined, b: PreviewKey | null | undefined): boolean =>
  !!a && !!b && a.resourceId === b.resourceId && a.version === b.version;

export type PreviewFailure =
  | { kind: "outOfOrder" | "overlap" | "oversized" | "inconsistent" | "hashMismatch" }
  /** The core refused the `preview` command. */
  | { kind: "refused"; code: AckFailureCode };

export type PreviewPhase = "loading" | "verifying" | "complete" | "failed";
export type Outcome = { kind: "accepted" } | { kind: "ignored" } | { kind: "rejected"; failure: PreviewFailure };

const FAILURE_TEXT: Record<PreviewFailure["kind"], string> = {
  outOfOrder: "parts of it arrived out of order",
  overlap: "parts of it overlapped",
  oversized: "it was larger than Scout allows",
  inconsistent: "its parts did not agree",
  hashMismatch: "its content did not match its fingerprint",
  refused: "Scout refused to show it",
};
export const failureText = (f: PreviewFailure): string => FAILURE_TEXT[f.kind];

/** Field-for-field equality for JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("\0") !== kb.join("\0")) return false;
  return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class PreviewAssembler {
  phase: PreviewPhase = "loading";
  failure: PreviewFailure | null = null;
  bytes: Uint8Array = new Uint8Array(0);
  totalBytes: number | null = null;
  sha256: string | null = null;
  descriptor: PreviewDescriptor | null = null;
  private nextSeq = 0;
  private nextCursor: string | null = null;

  constructor(readonly key: PreviewKey) {}

  get isComplete(): boolean {
    return this.phase === "complete";
  }

  /** The text received so far. Chunks never split a code point, so a partial preview decodes cleanly. */
  get text(): string {
    return new TextDecoder().decode(this.bytes);
  }

  /** The request for the first chunk, or the next one while loading. */
  requestNext(): PanelRequest | null {
    if (this.phase !== "loading") return null;
    const base = { type: "preview" as const, resourceId: this.key.resourceId, version: this.key.version };
    if (this.nextSeq === 0) return base;
    return this.nextCursor === null ? null : { ...base, cursor: this.nextCursor };
  }

  accept(chunk: PanelPreviewChunk): Outcome {
    if (chunk.resourceId !== this.key.resourceId || chunk.version !== this.key.version) return { kind: "ignored" };
    if (this.phase !== "loading") return { kind: "ignored" };
    if (chunk.seq < this.nextSeq) return { kind: "ignored" };
    if (chunk.seq !== this.nextSeq) return this.fail({ kind: "outOfOrder" });
    if (chunk.offset !== this.bytes.length) return this.fail({ kind: chunk.offset < this.bytes.length ? "overlap" : "outOfOrder" });
    if (this.totalBytes !== null && this.sha256 !== null && this.descriptor !== null) {
      if (chunk.totalBytes !== this.totalBytes || chunk.sha256 !== this.sha256 || !jsonEqual(chunk.descriptor, this.descriptor)) {
        return this.fail({ kind: "inconsistent" });
      }
    }
    if (chunk.totalBytes > RESOURCE_MAX_BYTES) return this.fail({ kind: "oversized" });
    const piece = new TextEncoder().encode(chunk.text);
    if (piece.length > PREVIEW_CHUNK_MAX_BYTES || chunk.offset + piece.length > chunk.totalBytes) return this.fail({ kind: "oversized" });
    const end = chunk.offset + piece.length;
    if (chunk.nextCursor !== undefined) {
      // A middle chunk must make progress and leave something for the next one.
      if (piece.length === 0 || end >= chunk.totalBytes) return this.fail({ kind: "inconsistent" });
    } else if (end !== chunk.totalBytes) return this.fail({ kind: "inconsistent" });

    this.totalBytes = chunk.totalBytes;
    this.sha256 = chunk.sha256;
    this.descriptor = chunk.descriptor;
    const joined = new Uint8Array(this.bytes.length + piece.length);
    joined.set(this.bytes);
    joined.set(piece, this.bytes.length);
    this.bytes = joined;
    this.nextSeq++;
    this.nextCursor = chunk.nextCursor ?? null;
    if (chunk.nextCursor === undefined) this.phase = "verifying";
    return { kind: "accepted" };
  }

  /** The SHA-256 of `bytes` (lowercase hex), computed after the last chunk. */
  verified(digest: string): Outcome {
    if (this.phase !== "verifying") return { kind: "ignored" };
    if (digest !== this.sha256) return this.fail({ kind: "hashMismatch" });
    this.phase = "complete";
    return { kind: "accepted" };
  }

  /** The core answered the `preview` command for this version with a failure ack. */
  refused(code: AckFailureCode): void {
    if (this.phase !== "loading") return;
    this.phase = "failed";
    this.failure = { kind: "refused", code };
  }

  private fail(failure: PreviewFailure): Outcome {
    this.phase = "failed";
    this.failure = failure;
    return { kind: "rejected", failure };
  }
}

/** Accepts `chunk` and, after the last one, verifies the hash (tests and the panel adapter). */
export async function acceptAndVerify(a: PreviewAssembler, chunk: PanelPreviewChunk): Promise<Outcome> {
  const out = a.accept(chunk);
  if (out.kind !== "accepted" || a.phase !== "verifying") return out;
  return a.verified(await sha256Hex(a.bytes));
}
