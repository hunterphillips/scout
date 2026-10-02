// Ported from native/Scout/Tests/ScoutKitTests/PreviewAssemblerTests.swift, over the same
// fixtures; the hash check is WebCrypto's (asynchronous), so a complete preview passes
// through `verifying` first.
import { PREVIEW_CHUNK_MAX_BYTES as CONTRACT_CHUNK, RESOURCE_MAX_BYTES as CONTRACT_RESOURCE, type PanelPreviewChunk } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { acceptAndVerify, PREVIEW_CHUNK_MAX_BYTES, PreviewAssembler, RESOURCE_MAX_BYTES, sha256Hex } from "./preview.js";
import { chunks, descriptor, F } from "./test-frames.js";

const key = { resourceId: F.rid, version: F.v1 };
const x = (over: Partial<PanelPreviewChunk>): PanelPreviewChunk => ({
  type: "preview",
  commandId: "x",
  resourceId: F.rid,
  version: F.v1,
  seq: 0,
  offset: 0,
  totalBytes: 0,
  text: "",
  sha256: F.v2,
  descriptor,
  ...over,
});

describe("PreviewAssembler (PreviewAssemblerTests.swift)", () => {
  it("the limits are the contract's", () => {
    expect(PREVIEW_CHUNK_MAX_BYTES).toBe(CONTRACT_CHUNK);
    expect(RESOURCE_MAX_BYTES).toBe(CONTRACT_RESOURCE);
  });

  it("assemblesMultiByteTextSplitAcrossChunks", async () => {
    const text = "naïve café ✓ 日本語 🧭\n".repeat(40);
    const cs = chunks(text, key, 37);
    expect(cs.length).toBeGreaterThan(10);
    const a = new PreviewAssembler(key);
    expect(a.requestNext()).toEqual({ type: "preview", resourceId: F.rid, version: F.v1 });
    for (const [i, c] of cs.entries()) {
      expect(a.isComplete).toBe(false);
      expect(await acceptAndVerify(a, c)).toEqual({ kind: "accepted" });
      if (i < cs.length - 1) expect(a.requestNext()).toEqual({ type: "preview", resourceId: F.rid, version: F.v1, cursor: `cur${i + 1}` });
    }
    expect(a.isComplete).toBe(true);
    expect(a.text).toBe(text);
    expect(a.requestNext()).toBeNull();
    expect(a.descriptor).toEqual(descriptor);
  });

  it("assemblesTheFixtureChunks", async () => {
    const first = F.frame("frame.preview.first.json");
    const last = F.frame("frame.preview.last.json");
    if (first.type !== "preview" || last.type !== "preview") throw new Error("fixtures");
    const a = new PreviewAssembler(key);
    expect(a.accept(first)).toEqual({ kind: "accepted" });
    expect(a.accept(last)).toEqual({ kind: "accepted" });
    expect(a.phase).toBe("verifying"); // not approvable until the hash is checked
    expect(a.verified(await sha256Hex(a.bytes))).toEqual({ kind: "accepted" });
    expect(a.isComplete).toBe(true);
    expect(a.text).toBe("# Guide — naïve café ✓ 日本語\n".repeat(3));
  });

  it("the single-chunk skill fixture completes", async () => {
    const one = F.frame("frame.preview.single-skill.json");
    if (one.type !== "preview") throw new Error("fixture");
    const a = new PreviewAssembler({ resourceId: one.resourceId, version: one.version });
    expect(await acceptAndVerify(a, one)).toEqual({ kind: "accepted" });
    expect(a.isComplete).toBe(true);
    expect(a.descriptor?.skill?.name).toBe("deploy");
  });

  it("emptyResourceIsOneEmptyChunk", async () => {
    const a = new PreviewAssembler(key);
    expect(await acceptAndVerify(a, chunks("", key, 10)[0]!)).toEqual({ kind: "accepted" });
    expect(a.isComplete).toBe(true);
    expect(a.text).toBe("");
  });

  it("rejectsOutOfOrderChunk", () => {
    const cs = chunks("x".repeat(100), key, 30);
    const a = new PreviewAssembler(key);
    expect(a.accept(cs[0]!)).toEqual({ kind: "accepted" });
    expect(a.accept(cs[2]!)).toEqual({ kind: "rejected", failure: { kind: "outOfOrder" } });
    expect(a.phase).toBe("failed");
    expect(a.accept(cs[1]!)).toEqual({ kind: "ignored" });
    expect(a.isComplete).toBe(false);
    expect(a.requestNext()).toBeNull();
  });

  it("replayedChunkIsIgnored", () => {
    const cs = chunks("x".repeat(100), key, 30);
    const a = new PreviewAssembler(key);
    a.accept(cs[0]!);
    a.accept(cs[1]!);
    expect(a.accept(cs[0]!)).toEqual({ kind: "ignored" });
    expect(a.phase).toBe("loading");
  });

  it("rejectsOverlapAndInconsistentChunks", () => {
    const cs = chunks("x".repeat(100), key, 30);
    const overlap = new PreviewAssembler(key);
    overlap.accept(cs[0]!);
    expect(overlap.accept(x({ seq: 1, offset: 10, totalBytes: 100, text: "x", sha256: cs[0]!.sha256, nextCursor: "c" }))).toEqual({ kind: "rejected", failure: { kind: "overlap" } });

    const total = new PreviewAssembler(key);
    total.accept(cs[0]!);
    expect(total.accept(x({ seq: 1, offset: 30, totalBytes: 101, text: cs[1]!.text, sha256: cs[1]!.sha256, nextCursor: "c" }))).toEqual({ kind: "rejected", failure: { kind: "inconsistent" } });

    const desc = new PreviewAssembler(key);
    desc.accept(cs[0]!);
    expect(
      desc.accept(x({ seq: 1, offset: 30, totalBytes: 100, text: cs[1]!.text, sha256: cs[1]!.sha256, descriptor: { kind: "agents_md", siteOrigin: F.origin, sourceUrl: `${F.origin}/AGENTS.md` }, nextCursor: "c" })),
    ).toEqual({ kind: "rejected", failure: { kind: "inconsistent" } });
  });

  it("rejectsOversizedPreview", () => {
    const a = new PreviewAssembler(key);
    expect(a.accept(x({ totalBytes: RESOURCE_MAX_BYTES + 1, text: "abc", nextCursor: "c" }))).toEqual({ kind: "rejected", failure: { kind: "oversized" } });
  });

  it("lastChunkMustEndAtTotalBytes", () => {
    const a = new PreviewAssembler(key);
    expect(a.accept(x({ totalBytes: 10, text: "abc" }))).toEqual({ kind: "rejected", failure: { kind: "inconsistent" } });
  });

  it("hashMismatchNeverCompletes", async () => {
    const c = chunks("hello world", key, 100)[0]!;
    const a = new PreviewAssembler(key);
    expect(await acceptAndVerify(a, { ...c, sha256: "0".repeat(64) })).toEqual({ kind: "rejected", failure: { kind: "hashMismatch" } });
    expect(a.isComplete).toBe(false);
    expect(a.failure).toEqual({ kind: "hashMismatch" });
  });

  it("wrongVersionChunkIsIgnored", async () => {
    const other = { resourceId: F.rid, version: F.v2 };
    const a = new PreviewAssembler(key);
    expect(a.accept(chunks("hello", other, 100)[0]!)).toEqual({ kind: "ignored" });
    expect(a.phase).toBe("loading");
    expect(a.bytes.length).toBe(0);
    expect(await acceptAndVerify(a, chunks("hello", key, 100)[0]!)).toEqual({ kind: "accepted" });
    expect(a.isComplete).toBe(true);
  });

  it("refusalFailsALoadingPreviewOnly", async () => {
    const a = new PreviewAssembler(key);
    a.refused("not_found");
    expect(a.failure).toEqual({ kind: "refused", code: "not_found" });
    const done = new PreviewAssembler(key);
    await acceptAndVerify(done, chunks("hi", key, 10)[0]!);
    done.refused("unavailable");
    expect(done.isComplete).toBe(true);
  });

  it("a verifying preview ignores a late hash for another state and never completes without one", async () => {
    const a = new PreviewAssembler(key);
    expect(a.verified("00")).toEqual({ kind: "ignored" });
    a.accept(chunks("hi", key, 10)[0]!);
    expect(a.isComplete).toBe(false);
    a.refused("unavailable"); // only loading previews are refused
    expect(a.phase).toBe("verifying");
  });
});
