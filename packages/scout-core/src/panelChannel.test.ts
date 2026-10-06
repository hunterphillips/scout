import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_DESTINATIONS_MAX, PanelStateSchema, PREVIEW_CHUNK_MAX_BYTES, type PanelCapabilities, type PanelPreviewChunk, type PanelState } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { ReadAuditEntry } from "./agentApi/readAudit.js";
import { emptyState } from "./capabilities/decisions.js";
import { createCapabilityStore } from "./capabilities/store.js";
import type { Timers } from "./clock.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createPanelChannel, type PanelChannelOptions, type PanelStore } from "./panelChannel.js";
import { createLiveDestinations } from "./wiring/destinations.js";
import { writeAgentProfile } from "./agents/profile.js";
import { agentChoices, switchAgent } from "./agents/profileSwitch.js";
import { createResultRegistry, type ResultRegistry } from "./results.js";

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

function setup(
  overrides: {
    store?: PanelStore;
    isPermitted?: (origin: string) => boolean;
    results?: ResultRegistry;
    resendState?: () => void;
    readDestinations?: () => readonly string[];
    setDestination?: PanelChannelOptions["setDestination"];
    readAgents?: PanelChannelOptions["readAgents"];
    setAgent?: PanelChannelOptions["setAgent"];
  } = {},
) {
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
    ...(overrides.results ? { results: overrides.results } : {}),
    ...(overrides.resendState ? { resendState: overrides.resendState } : {}),
    ...(overrides.readDestinations ? { readDestinations: overrides.readDestinations } : {}),
    ...(overrides.setDestination ? { setDestination: overrides.setDestination } : {}),
    ...(overrides.readAgents ? { readAgents: overrides.readAgents } : {}),
    ...(overrides.setAgent ? { setAgent: overrides.setAgent } : {}),
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

  it("puts the configured destinations on every grant frame as https origins, bounded, and the frame stays in the contract", async () => {
    const hosts = ["docs.stripe.com", "www.peakdesign.com", "docs.stripe.com", "h.example:8443", ...Array.from({ length: 70 }, (_, i) => `h${i}.example`)];
    const s = setup({ readDestinations: () => hosts });
    s.channel.start();
    const grant = s.frames[0] as Extract<PanelState, { type: "grant" }>;
    expect(grant.destinations?.slice(0, 3)).toEqual(["https://docs.stripe.com", "https://www.peakdesign.com", "https://h.example:8443"]);
    expect(grant.destinations).toHaveLength(GRANT_DESTINATIONS_MAX);
    expect(PanelStateSchema.safeParse(grant).success).toBe(true);
    // The toggle's grant frame and a repaint carry them too.
    s.frames.length = 0;
    await s.channel.handle({ type: "set_agent_browser_context", commandId: "g1", enabled: false, expectedEnabled: true });
    expect(s.frames.find((f) => f.type === "grant")).toMatchObject({ destinations: expect.arrayContaining(["https://docs.stripe.com"]) });
    const got: PanelState[] = [];
    s.channel.repaint({ id: "relay-1", kind: "relay", send: (f) => void got.push(f) }, { type: "state", status: "disconnected" });
    expect(got[0]).toMatchObject({ type: "grant", destinations: expect.arrayContaining(["https://www.peakdesign.com"]) });
  });

  it("set_destination (P4.6): writes config.json, sends the new list as a grant frame before the ack, idempotent per sender; stale is stale_revision", async () => {
    const home = mkdtempSync(join(tmpdir(), "spc-dst-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ agentBrowserContext: true, destinations: [] }));
      let channel: ReturnType<typeof setup>["channel"] | null = null;
      const live = createLiveDestinations({ home, initial: [], onChanged: () => channel?.destinationsChanged(), diagnostics: { failures: 0, event: () => {} }, timers: { setTimeout: () => 0, clearTimeout: () => {} }, watch: () => ({ close: () => {} }) });
      const s = setup({ readDestinations: () => live.current(), setDestination: (o, e, x) => live.set(o, e, x) });
      channel = s.channel;
      s.channel.start();
      expect(s.frames[0]).toEqual({ type: "grant", agentBrowserContext: true, destinations: [] });
      s.frames.length = 0;
      const on = { type: "set_destination" as const, commandId: "d1", origin: "https://docs.stripe.com", enabled: true, expectedEnabled: false };
      await s.channel.handle(on, "relay-1");
      expect(s.frames).toEqual([
        { type: "grant", agentBrowserContext: true, destinations: ["https://docs.stripe.com"] },
        { type: "ack", commandId: "d1", ok: true, revision: 0, approvalRevision: 0 },
      ]);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ agentBrowserContext: true, destinations: ["docs.stripe.com"] });
      // The same ID from the same sender: the first ack again, nothing written.
      s.frames.length = 0;
      await s.channel.handle(on, "relay-1");
      expect(s.frames).toEqual([{ type: "ack", commandId: "d1", ok: true, revision: 0, approvalRevision: 0 }]);
      // A new command from what the user saw before: stale.
      await s.channel.handle({ ...on, commandId: "d2" }, "relay-1");
      expect(s.frames.at(-1)).toEqual({ type: "ack", commandId: "d2", ok: false, code: "stale_revision" });
      live.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("set_agent: the capabilities frame carries the agent choice; the ack is followed by a frame showing the new agent; a retried ID is answered from the cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "spc-agent-"));
    try {
      const bin = join(home, "bin");
      mkdirSync(bin);
      for (const name of ["claude", "codex"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, name), 0o755);
      }
      writeAgentProfile(home, { schemaVersion: 1, adapter: "claude-code", claudePath: join(bin, "claude"), model: "claude-sonnet-5-5", tools: { revision: 2, connections: [], selections: [] } });
      const writes: string[] = [];
      const s = setup({ readAgents: () => agentChoices(home, { PATH: bin }), setAgent: (a) => (writes.push(a), switchAgent(home, a, { PATH: bin })) });
      s.channel.start();
      const first = s.frames[1] as PanelCapabilities;
      expect(first.agents).toEqual({ available: [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }], current: "claude-code" });
      expect(PanelStateSchema.safeParse(first).success).toBe(true);

      s.frames.length = 0;
      const cmd = { type: "set_agent" as const, commandId: "a1", agent: "codex" };
      await s.channel.handle(cmd, "relay-1");
      expect(s.frames).toEqual([{ type: "ack", commandId: "a1", ok: true, revision: 0, approvalRevision: 0 }]);
      s.fire();
      expect(s.frames[1]).toMatchObject({ type: "capabilities", revision: 2, agents: { current: "codex" } });
      expect(JSON.parse(readFileSync(join(home, "agent-profile.json"), "utf8"))).toMatchObject({ adapter: "codex", tools: { revision: 2 } });

      // The same ID again: the first ack, the writer not called.
      s.frames.length = 0;
      await s.channel.handle(cmd, "relay-1");
      expect(s.frames).toEqual([{ type: "ack", commandId: "a1", ok: true, revision: 0, approvalRevision: 0 }]);
      expect(writes).toEqual(["codex"]);
      // A new command naming the current agent is ok and changes nothing.
      await s.channel.handle({ ...cmd, commandId: "a2" }, "relay-1");
      expect(s.frames.at(-1)).toEqual({ type: "ack", commandId: "a2", ok: true, revision: 0, approvalRevision: 0 });
      s.fire();
      expect(s.frames.filter((f) => f.type === "capabilities")).toEqual([]);

      // An agent whose executable is gone is refused, and so is an unknown one.
      rmSync(join(bin, "claude"));
      await s.channel.handle({ ...cmd, commandId: "a3", agent: "claude-code" }, "relay-1");
      expect(s.frames.at(-1)).toEqual({ type: "ack", commandId: "a3", ok: false, code: "not_found" });
      await s.channel.handle({ ...cmd, commandId: "a4", agent: "other-agent" }, "relay-1");
      expect(s.frames.at(-1)).toEqual({ type: "ack", commandId: "a4", ok: false, code: "invalid" });
      expect(JSON.parse(readFileSync(join(home, "agent-profile.json"), "utf8"))).toMatchObject({ adapter: "codex" });
      expect(s.events.filter((e) => e.name === "native_command").map((e) => e.fields)).toEqual([
        { type: "set_agent", ok: true },
        { type: "set_agent", ok: true },
        { type: "set_agent", ok: true },
        { type: "set_agent", ok: false, code: "not_found" },
        { type: "set_agent", ok: false, code: "invalid" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("set_agent without a writer acks unavailable, and a frame without an agent reader carries no agents", async () => {
    const s = setup();
    s.channel.start();
    expect(s.frames[1]).not.toHaveProperty("agents");
    await s.channel.handle({ type: "set_agent", commandId: "a1", agent: "codex" });
    expect(s.frames.at(-1)).toEqual({ type: "ack", commandId: "a1", ok: false, code: "unavailable" });
  });

  it("set_destination without a writer acks unavailable", async () => {
    const s = setup();
    await s.channel.handle({ type: "set_destination", commandId: "d1", origin: "https://docs.stripe.com", enabled: true, expectedEnabled: false });
    expect(s.frames).toEqual([{ type: "ack", commandId: "d1", ok: false, code: "unavailable" }]);
  });

  it("sends an empty destinations list when none is configured", () => {
    const s = setup({ readDestinations: () => [] });
    s.channel.start();
    expect(s.frames[0]).toEqual({ type: "grant", agentBrowserContext: true, destinations: [] });
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

  describe("results", () => {
    const SITE = "https://docs.example.com";
    const registry = () =>
      createResultRegistry({ coreInstanceId: "core-test", activeVisit: () => ({ visitEpoch: 2, origin: SITE }), isPermitted: () => true });
    const result = {
      coreInstanceId: "core-test",
      visitEpoch: 2,
      origin: SITE,
      jobId: "job-1",
      status: "ok" as const,
      items: [{ candidateId: "c1", title: "Webhooks", reason: "r", href: `${SITE}/webhooks`, hostname: "docs.example.com" }],
    };

    it("sends a published result as a frame without its href, and answers open_link from it", async () => {
      const results = registry();
      const s = setup({ results });
      results.beginJob("job-1");
      results.publish(result);
      expect(s.frames).toEqual([
        {
          type: "results",
          coreInstanceId: "core-test",
          visitEpoch: 2,
          origin: SITE,
          jobId: "job-1",
          status: "ok",
          items: [{ candidateId: "c1", title: "Webhooks", reason: "r", hostname: "docs.example.com" }],
        },
      ]);
      await s.channel.handle({ type: "open_link", commandId: "o1", coreInstanceId: "core-test", visitEpoch: 2, jobId: "job-1", candidateId: "c1" });
      expect(s.frames.at(-1)).toMatchObject({ type: "ack", commandId: "o1", ok: true, target: { href: `${SITE}/webhooks` } });
    });

    it("repaints a new sink with grant, capabilities (to every sink), audit, the given state, and the held result, without hrefs", () => {
      const results = registry();
      const s = setup({ results });
      s.audit.push({ at: 5, role: "job", method: "current_site", outcome: "ok" });
      results.beginJob("job-1");
      results.publish(result);
      s.frames.length = 0;
      const got: PanelState[] = [];
      const state: PanelState = { type: "state", status: "idle", visitEpoch: 2, detail: "docs.example.com", permitted: true };
      s.channel.repaint({ id: "relay-1", kind: "relay", send: (f) => void got.push(f) }, state);
      expect(got.map((f) => f.type)).toEqual(["grant", "audit", "state", "results"]);
      expect(got[1]).toEqual({ type: "audit", entries: [{ at: 5, role: "job", method: "current_site", outcome: "ok" }] });
      expect(got[2]).toBe(state);
      expect(got[3]).toMatchObject({ type: "results", jobId: "job-1", status: "ok" });
      expect(JSON.stringify(got)).not.toContain("/webhooks");
      // The capabilities refresh went through the channel's own emit (every sink), alone.
      expect(s.frames.map((f) => f.type)).toEqual(["capabilities"]);
      expect(s.events).toContainEqual({ name: "panel_repainted", fields: { sink: "relay", results: 1 } });
    });

    it("a clear re-sends the coordinator's state instead of a stand-in empty frame", () => {
      const results = registry();
      let resent = 0;
      const s = setup({ results, resendState: () => void resent++ });
      results.clear("visit_changed"); // nothing held: nothing to say
      expect(resent).toBe(0);
      results.beginJob("job-1");
      results.publish(result);
      results.clear("visit_changed");
      expect(resent).toBe(1);
      expect(s.frames.filter((f) => f.type === "results")).toHaveLength(1);
    });

    it("a silent clear (the coordinator's own) re-sends nothing", () => {
      const results = registry();
      let resent = 0;
      setup({ results, resendState: () => void resent++ });
      results.beginJob("job-1");
      results.publish(result);
      expect(results.clear("paused", { silent: true })).toBe(true);
      expect(results.current()).toBeNull();
      expect(resent).toBe(0);
    });

    it("stops listening when stopped", () => {
      const results = registry();
      let resent = 0;
      const s = setup({ results, resendState: () => void resent++ });
      s.channel.stop();
      results.beginJob("job-1");
      results.publish(result);
      results.clear("stopped");
      expect(s.frames).toEqual([]);
      expect(resent).toBe(0);
    });
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
