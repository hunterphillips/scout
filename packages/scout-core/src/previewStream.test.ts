import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelStateSchema, type PanelPreviewChunk, type PreviewCommand } from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import { UNUSED_EXPIRY_MS } from "./capabilities/garbageCollection.js";
import { type CapabilityStore, createCapabilityStore } from "./capabilities/store.js";
import { createPreviewStream, type PreviewStore } from "./previewStream.js";

const ORIGIN = "https://s.example";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function discovery(text: string, path = "/llms.txt"): DiscoveryResult {
  const sourceUrl = `${ORIGIN}${path}`;
  return {
    origin: ORIGIN,
    checkedAt: now,
    robots: "not_fetched",
    items: [
      {
        kind: "llms_txt",
        sourceUrl,
        status: "found",
        source: "network",
        resource: {
          kind: "llms_txt",
          siteOrigin: ORIGIN,
          publisherOrigin: ORIGIN,
          sourceUrl,
          finalUrl: sourceUrl,
          text,
          sha256: sha(text),
          byteLength: Buffer.byteLength(text),
          fetchedAt: now,
          contentType: "text/plain; charset=utf-8",
        },
      },
    ],
    externalReferences: [],
    skillsOverCap: 0,
    acceptedBytes: 0,
    stats: { requests: 0, refused: 0, ms: 0 },
  };
}

let home: string;
let now: number;
let store: CapabilityStore;
const clock = { now: () => now };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "scout-preview-"));
  now = 1_800_000_000_000;
  store = await createCapabilityStore({ scoutHome: home, clock });
});
afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

async function ingest(text: string) {
  const r = (await store.ingest(discovery(text), { chromePermitted: false })).results[0]!;
  return { resourceId: r.resourceId, version: r.version };
}

/** Wraps the store to watch pins. */
function watched() {
  const pinned = new Set<string>();
  const s: PreviewStore = {
    getResource: (id) => store.getResource(id),
    readBlob: (ref) => store.readBlob(ref),
    pinForPreview: (pinId, id, v) => {
      const ok = store.pinForPreview(pinId, id, v);
      if (ok) pinned.add(pinId);
      return ok;
    },
    releasePins: (pinId) => {
      pinned.delete(pinId);
      store.releasePins(pinId);
    },
  };
  return { store: s, pinned };
}

let n = 0;
const cmd = (target: { resourceId: string; version: string }, cursor?: string): PreviewCommand => ({
  type: "preview",
  commandId: `p${++n}`,
  ...target,
  ...(cursor !== undefined ? { cursor } : {}),
});

/** Follow the cursors to the end. */
function readAll(stream: ReturnType<typeof createPreviewStream>, target: { resourceId: string; version: string }): PanelPreviewChunk[] {
  const chunks: PanelPreviewChunk[] = [];
  let cursor: string | undefined;
  for (;;) {
    const a = stream.serve(cmd(target, cursor));
    if (!a.ok) throw new Error(a.code);
    chunks.push(a.chunk);
    cursor = a.chunk.nextCursor;
    if (cursor === undefined) return chunks;
  }
}

describe("preview stream", () => {
  it("chunks multi-byte text on code-point boundaries with the blob hash in every chunk", async () => {
    const text = "aé😀中".repeat(5000); // 10 bytes per repeat: 50 000 bytes, four chunks at 16 KiB
    const target = await ingest(text);
    const w = watched();
    const stream = createPreviewStream({ store: w.store, clock });
    const chunks = readAll(stream, target);
    expect(chunks.length).toBe(4);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    for (const c of chunks) {
      expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(16 * 1024);
      expect(c.text).not.toContain("�");
      expect(c.sha256).toBe(sha(text));
      expect(c.totalBytes).toBe(Buffer.byteLength(text));
      expect(c.descriptor).toEqual({ kind: "llms_txt", siteOrigin: ORIGIN, sourceUrl: `${ORIGIN}/llms.txt`, contentType: "text/plain; charset=utf-8" });
      expect(c.descriptor).toEqual(chunks[0]!.descriptor);
      expect(PanelStateSchema.safeParse(c).success).toBe(true);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    let offset = 0;
    for (const c of chunks) {
      expect(c.offset).toBe(offset);
      offset += Buffer.byteLength(c.text);
    }
    expect(chunks.at(-1)!.nextCursor).toBeUndefined();
    // The pin was held while reading and released on the last chunk.
    expect(w.pinned.size).toBe(0);
    expect(stream.openChains).toBe(0);
  });

  it("previews a pending version and keeps it from collection while the read is open", async () => {
    const target = await ingest("x".repeat(40));
    const w = watched();
    // A cursor that outlives the store's expiry, so collection runs while the read is open.
    const stream = createPreviewStream({ store: w.store, clock, chunkBytes: 16, ttlMs: 2 * UNUSED_EXPIRY_MS });
    const first = stream.serve(cmd(target));
    expect(first.ok && first.chunk.nextCursor).toBeTruthy();
    expect(w.pinned.size).toBe(1);
    now += UNUSED_EXPIRY_MS + 1;
    await store.collectGarbage();
    expect(store.getVersion(target.resourceId, target.version)).toBeDefined();
    // A retried command with the same cursor gets the same chunk again.
    const cursor = first.ok ? first.chunk.nextCursor! : "";
    const again1 = stream.serve(cmd(target, cursor));
    const again2 = stream.serve(cmd(target, cursor));
    expect(again1.ok && again1.chunk.offset).toBe(16);
    expect(again2.ok && again2.chunk.text).toBe(again1.ok && again1.chunk.text);
  });

  it("an expired cursor is not_found and its pin is released", async () => {
    const target = await ingest("y".repeat(40));
    const w = watched();
    const stream = createPreviewStream({ store: w.store, clock, chunkBytes: 16, ttlMs: 1000 });
    const first = stream.serve(cmd(target));
    const cursor = first.ok ? first.chunk.nextCursor! : "";
    expect(w.pinned.size).toBe(1);
    now += 1000;
    stream.sweepExpired();
    expect(w.pinned.size).toBe(0);
    expect(stream.serve(cmd(target, cursor))).toEqual({ ok: false, code: "not_found" });
  });

  it("a cursor for another version is invalid; unknown targets are not_found", async () => {
    const target = await ingest("z".repeat(40));
    const stream = createPreviewStream({ store: watched().store, clock, chunkBytes: 16 });
    const first = stream.serve(cmd(target));
    const cursor = first.ok ? first.chunk.nextCursor! : "";
    expect(stream.serve(cmd({ ...target, version: "f".repeat(64) }, cursor))).toMatchObject({ ok: false, code: "invalid" });
    expect(stream.serve(cmd({ ...target, version: "f".repeat(64) }))).toMatchObject({ ok: false, code: "not_found" });
    expect(stream.serve(cmd({ resourceId: `res_${"0".repeat(64)}`, version: target.version }))).toEqual({ ok: false, code: "not_found" });
  });

  it("a revoked resource's versions stay previewable, mid-read included, until collection drops them", async () => {
    const text = "w".repeat(40);
    const target = await ingest(text);
    await store.approve({ ...target, expectedRevision: store.getResource(target.resourceId)!.revision });
    const w = watched();
    const stream = createPreviewStream({ store: w.store, clock, chunkBytes: 16 });
    const first = stream.serve(cmd(target));
    const cursor = first.ok ? first.chunk.nextCursor! : "";
    await store.revoke(target.resourceId);
    expect(store.getResource(target.resourceId)!.resource.blocked).toBe(true);
    // The revocation dropped the pin; the next chunk takes it again.
    const second = stream.serve(cmd(target, cursor));
    expect(second).toMatchObject({ ok: true, chunk: { seq: 1, offset: 16 } });
    expect(w.pinned.size).toBe(1);
    expect(readAll(stream, target).map((c) => c.text).join("")).toBe(text);
  });

  it("a version whose blob is gone is not_found; an unreadable blob is unavailable", async () => {
    const target = await ingest("u".repeat(40));
    const v = store.getVersion(target.resourceId, target.version)!;
    const blob = join(home, "capabilities", "blobs", `${v.blobRef}.txt`);
    const stream = createPreviewStream({ store: watched().store, clock, chunkBytes: 16 });
    writeFileSync(blob, "tampered", { mode: 0o600 });
    expect(stream.serve(cmd(target))).toMatchObject({ ok: false, code: "unavailable" });
    unlinkSync(blob);
    expect(stream.serve(cmd(target))).toMatchObject({ ok: false, code: "not_found" });
  });

  it("close releases every open read", async () => {
    const target = await ingest("v".repeat(40));
    const w = watched();
    const stream = createPreviewStream({ store: w.store, clock, chunkBytes: 16 });
    stream.serve(cmd(target));
    stream.serve(cmd(target));
    expect(w.pinned.size).toBe(2);
    stream.close();
    expect(w.pinned.size).toBe(0);
  });
});
