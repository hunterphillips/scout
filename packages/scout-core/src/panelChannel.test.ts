import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_CHUNK_MAX_BYTES, type PanelCapabilities, type PanelPreviewChunk, type PanelState } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { ReadAuditEntry } from "./agentApi/readAudit.js";
import { emptyState } from "./capabilities/decisions.js";
import { createCapabilityStore } from "./capabilities/store.js";
import type { Timers } from "./clock.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createPanelChannel, type PanelStore } from "./panelChannel.js";

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  const timers: Timers = {
    setTimeout: (fn) => {
      pending.set(++id, fn);
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const fire = () => {
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  };
  return { timers, fire };
}

const emptyStore = {
  snapshot: () => emptyState(),
  getResource: () => undefined,
  originPolicy: () => undefined,
  readBlob: () => Buffer.alloc(0),
  pinForPreview: () => false,
  releasePins: () => {},
  approve: async () => {
    throw new Error("unused");
  },
  decline: async () => {
    throw new Error("unused");
  },
  revoke: async () => {
    throw new Error("unused");
  },
  setOriginPolicy: async () => {
    throw new Error("unused");
  },
  approvalRevision: 0,
} satisfies PanelStore;

function setup(overrides: { store?: PanelStore; isPermitted?: (origin: string) => boolean } = {}) {
  const t = fakeTimers();
  const frames: PanelState[] = [];
  const audit: ReadAuditEntry[] = [];
  const events: { name: string; fields: DiagnosticFields }[] = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const channel = createPanelChannel({
    store: overrides.store ?? emptyStore,
    coreInstanceId: "core-test",
    exportConflicts: () => {
      throw new Error("manifest unreadable");
    },
    readBrowserContextGrant: () => true,
    writeBrowserContextGrant: () => ({ restore: () => {} }),
    getAudit: () => audit,
    isPermitted: overrides.isPermitted ?? (() => false),
    currentOrigin: () => null,
    emit: (f) => void frames.push(f),
    clock: { now: () => 0 },
    timers: t.timers,
    diagnostics,
  });
  return { channel, frames, audit, events, fire: t.fire };
}

describe("panel channel", () => {
  it("starts with the grant, the capability view, and the audit", () => {
    const s = setup();
    s.channel.start();
    expect(s.frames.map((f) => f.type)).toEqual(["grant", "capabilities", "audit"]);
    expect(s.frames[0]).toEqual({ type: "grant", agentBrowserContext: true });
    // An unreadable manifest shows no conflicts rather than no frame.
    expect(s.frames[1]).toMatchObject({ coreInstanceId: "core-test", revision: 1, conflicts: [], offers: [], library: [] });
  });

  it("sends the audit debounced, only when it changed, without any text", () => {
    const s = setup();
    s.channel.start();
    s.frames.length = 0;
    s.audit.push({ at: 5, role: "interactive", method: "site_links", outcome: "ok", origin: "https://a.example" });
    s.channel.auditChanged();
    s.channel.auditChanged();
    expect(s.frames).toEqual([]);
    s.fire();
    expect(s.frames).toEqual([{ type: "audit", entries: [{ at: 5, role: "interactive", method: "site_links", outcome: "ok", origin: "https://a.example" }] }]);
    s.channel.auditChanged();
    s.fire();
    expect(s.frames).toHaveLength(1);
  });

  it("answers a failed preview with an ack and logs scalars only", async () => {
    const s = setup();
    await s.channel.handle({ type: "preview", commandId: "p1", resourceId: `res_${"a".repeat(64)}`, version: "b".repeat(64) });
    expect(s.frames).toEqual([{ type: "ack", commandId: "p1", ok: false, code: "not_found" }]);
    expect(s.events.find((e) => e.name === "native_command")?.fields).toEqual({ type: "preview", ok: false, code: "not_found" });
  });

  it("sends nothing after stop", async () => {
    const s = setup();
    s.channel.stop();
    s.channel.start();
    s.channel.auditChanged();
    s.fire();
    await s.channel.handle({ type: "refresh_capabilities", commandId: "r1" });
    expect(s.frames).toEqual([]);
  });

  it("a permission loss while a preview is open drops the offer on the next frame and the next chunk is still served", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-channel-"));
    const now = 1_800_000_000_000;
    const store = await createCapabilityStore({ scoutHome: home, clock: { now: () => now } });
    try {
      const origin = "https://s.example";
      const sourceUrl = `${origin}/llms.txt`;
      const text = "x".repeat(PREVIEW_CHUNK_MAX_BYTES + 10);
      const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
      const report = await store.ingest(
        {
          origin,
          checkedAt: now,
          robots: "not_fetched",
          items: [
            {
              kind: "llms_txt",
              sourceUrl,
              status: "found",
              source: "network",
              resource: { kind: "llms_txt", siteOrigin: origin, publisherOrigin: origin, sourceUrl, finalUrl: sourceUrl, text, sha256, byteLength: text.length, fetchedAt: now },
            },
          ],
          externalReferences: [],
          skillsOverCap: 0,
          acceptedBytes: 0,
          stats: { requests: 0, refused: 0, ms: 0 },
        },
        { chromePermitted: false },
      );
      const { resourceId, version } = report.results[0]!;
      let permitted = true;
      const s = setup({ store, isPermitted: () => permitted });
      s.channel.start();
      const caps = () => s.frames.filter((f): f is PanelCapabilities => f.type === "capabilities");
      expect(caps().at(-1)!.offers).toHaveLength(1);

      await s.channel.handle({ type: "preview", commandId: "p1", resourceId, version });
      const first = s.frames.at(-1) as PanelPreviewChunk;
      expect(first).toMatchObject({ type: "preview", seq: 0 });
      expect(first.nextCursor).toBeDefined();

      permitted = false;
      s.channel.capabilitiesChanged();
      s.fire();
      expect(caps().at(-1)!.offers).toEqual([]);

      await s.channel.handle({ type: "preview", commandId: "p2", resourceId, version, cursor: first.nextCursor! });
      expect(s.frames.at(-1)).toMatchObject({ type: "preview", seq: 1, offset: PREVIEW_CHUNK_MAX_BYTES, sha256 });
      s.channel.stop();
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
