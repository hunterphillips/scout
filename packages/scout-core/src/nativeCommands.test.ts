import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationCommand, PanelAck } from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "./agentApi/auth.js";
import { readBrowserContextGrant, writeBrowserContextGrant } from "./agentApi/grants.js";
import { type AgentConnection, createAgentHandlers } from "./agentApi/handlers.js";
import { createReadAudit } from "./agentApi/readAudit.js";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import { type CapabilityStore, createCapabilityStore } from "./capabilities/store.js";
import { createCatalogCache } from "./catalog/cache.js";
import { readConfig } from "./config.js";
import { type CommandStore, createNativeCommands, type NativeCommandsOptions } from "./nativeCommands.js";
import { buildCapabilities } from "./panelCapabilities.js";
import { createPreviewStream } from "./previewStream.js";

const ORIGIN = "https://s.example";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function discovery(text: string): DiscoveryResult {
  const sourceUrl = `${ORIGIN}/llms.txt`;
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
        resource: { kind: "llms_txt", siteOrigin: ORIGIN, publisherOrigin: ORIGIN, sourceUrl, finalUrl: sourceUrl, text, sha256: sha(text), byteLength: Buffer.byteLength(text), fetchedAt: now },
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
  home = mkdtempSync(join(tmpdir(), "scout-cmds-"));
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
const rev = (id: string) => store.getResource(id)!.revision;

function setup(extra: Partial<NativeCommandsOptions> & { permitted?: boolean; storeOverride?: CommandStore } = {}) {
  const acks: PanelAck[] = [];
  const grants: boolean[] = [];
  const counts = { changed: 0, refresh: 0, approve: 0, policy: 0 };
  const base = extra.storeOverride ?? store;
  const counted: CommandStore = {
    getResource: (id) => base.getResource(id),
    originPolicy: (o) => base.originPolicy(o),
    approve: (c) => {
      counts.approve++;
      return base.approve(c);
    },
    decline: (c) => base.decline(c),
    revoke: (id, expected) => base.revoke(id, expected),
    setOriginPolicy: (c) => {
      counts.policy++;
      return base.setOriginPolicy(c);
    },
    get approvalRevision() {
      return base.approvalRevision;
    },
  };
  const commands = createNativeCommands({
    store: counted,
    isPermitted: () => extra.permitted ?? true,
    writeBrowserContextGrant: (enabled) => writeBrowserContextGrant(home, enabled),
    readBrowserContextGrant: () => readBrowserContextGrant(home),
    emitAck: (a) => void acks.push(a),
    onStoreChanged: () => void counts.changed++,
    onGrantChanged: (enabled) => void grants.push(enabled),
    refreshCapabilities: () => void counts.refresh++,
    ...extra,
  });
  return { commands, acks, grants, counts };
}

const approve = (commandId: string, t: { resourceId: string; version: string }, expectedRevision: number): MutationCommand => ({
  type: "approve",
  commandId,
  ...t,
  expectedRevision,
});

describe("native commands", () => {
  it("approve persists the decision before the ack is emitted", async () => {
    const t = await ingest("guide v1");
    let stateAtAck: string | undefined;
    const s = setup({
      emitAck: (a) => {
        stateAtAck = store.getResource(t.resourceId)!.resource.versions[0]!.state;
        // The decision is on disk, not only in memory.
        const onDisk = JSON.parse(readFileSync(join(home, "capabilities", "store.json"), "utf8"));
        expect(onDisk.resources[0].resource.defaultVersion).toBe(t.version);
        void a;
      },
    });
    await s.commands.handle(approve("a1", t, rev(t.resourceId)));
    expect(stateAtAck).toBe("approved");
  });

  it("acks ok with the new revisions and announces the change after the ack", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    await s.commands.handle(approve("a1", t, rev(t.resourceId)));
    expect(s.acks).toEqual([{ type: "ack", commandId: "a1", ok: true, revision: rev(t.resourceId), approvalRevision: store.approvalRevision }]);
    expect(s.counts.changed).toBeGreaterThanOrEqual(1);
  });

  it("a stale revision is refused with the current one", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    await s.commands.handle(approve("a1", t, rev(t.resourceId) + 7));
    expect(s.acks).toEqual([{ type: "ack", commandId: "a1", ok: false, code: "stale_revision", revision: rev(t.resourceId) }]);
    expect(store.getResource(t.resourceId)!.resource.defaultVersion).toBeUndefined();
  });

  it("a retried command ID gets the identical ack and never reaches the store twice", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    const c = approve("a1", t, rev(t.resourceId));
    await Promise.all([s.commands.handle(c), s.commands.handle(c)]);
    await s.commands.handle(c);
    expect(s.counts.approve).toBe(1);
    expect(s.acks).toHaveLength(3);
    expect(s.acks[1]).toEqual(s.acks[0]);
    expect(s.acks[2]).toEqual(s.acks[0]);
    expect(s.acks[0]!.ok).toBe(true);
    // The same ID for a different command is refused.
    await s.commands.handle({ type: "refresh_capabilities", commandId: "a1" });
    expect(s.acks.at(-1)).toMatchObject({ commandId: "a1", ok: false, code: "invalid" });
  });

  it("a failed command ID runs again on retry", async () => {
    const t = await ingest("guide v1");
    let allowed = false;
    const s = setup({ isPermitted: () => allowed });
    await s.commands.handle(approve("a1", t, rev(t.resourceId)));
    expect(s.acks[0]).toMatchObject({ ok: false, code: "not_permitted" });
    expect(s.counts.approve).toBe(0);
    allowed = true;
    await s.commands.handle(approve("a1", t, rev(t.resourceId)));
    expect(s.acks[1]).toMatchObject({ ok: true });
    expect(s.counts.approve).toBe(1);
  });

  it("a declined version is not offered again when rediscovered", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    await s.commands.handle({ type: "decline", commandId: "d1", ...t, expectedRevision: rev(t.resourceId) });
    expect(s.acks[0]).toMatchObject({ ok: true });
    const report = await store.ingest(discovery("guide v1"), { chromePermitted: true });
    expect(report.results[0]!.outcome).toBe("declined");
    const body = buildCapabilities({ state: store.snapshot(), conflicts: [], isPermitted: () => true, currentOrigin: null });
    expect(body.offers).toEqual([]);
  });

  it("revoke blocks after commit, acks, and later previews stay readable", async () => {
    const t = await ingest("guide v1");
    await store.approve({ ...t, expectedRevision: rev(t.resourceId) });
    let blockedAtAck: boolean | undefined;
    const s = setup({ emitAck: () => void (blockedAtAck = store.getResource(t.resourceId)!.resource.blocked) });
    await s.commands.handle({ type: "revoke", commandId: "r1", resourceId: t.resourceId, expectedRevision: rev(t.resourceId) });
    expect(blockedAtAck).toBe(true);
    expect(store.resolveRead(t.resourceId)).toEqual({ ok: false, code: "revoked" });
    const previews = createPreviewStream({ store, clock });
    expect(previews.serve({ type: "preview", commandId: "p1", ...t })).toMatchObject({ ok: true, chunk: { text: "guide v1" } });
    // Revoking an already-blocked resource acks ok whatever revision the app had.
    const again = setup();
    await again.commands.handle({ type: "revoke", commandId: "r2", resourceId: t.resourceId, expectedRevision: 0 });
    expect(again.acks[0]).toMatchObject({ ok: true });
  });

  it("revoke with a stale revision is refused; unknown resources are not_found", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    await s.commands.handle({ type: "revoke", commandId: "r1", resourceId: t.resourceId, expectedRevision: rev(t.resourceId) + 1 });
    await s.commands.handle({ type: "revoke", commandId: "r2", resourceId: `res_${"0".repeat(64)}`, expectedRevision: 0 });
    expect(s.acks).toEqual([
      { type: "ack", commandId: "r1", ok: false, code: "stale_revision", revision: rev(t.resourceId) },
      { type: "ack", commandId: "r2", ok: false, code: "not_found" },
    ]);
    expect(store.getResource(t.resourceId)!.resource.blocked).toBe(false);
  });

  it("enabling auto-acquire needs the risk acknowledgement and the origin's grant", async () => {
    const s = setup();
    await s.commands.handle({ type: "set_auto_acquire", commandId: "s1", origin: ORIGIN, enabled: true, expectedEnabled: false, acknowledgeRisk: false });
    expect(s.acks[0]).toMatchObject({ ok: false, code: "invalid" });
    expect(store.originPolicy(ORIGIN)).toBeUndefined();

    const denied = setup({ permitted: false });
    await denied.commands.handle({ type: "set_auto_acquire", commandId: "s2", origin: ORIGIN, enabled: true, expectedEnabled: false, acknowledgeRisk: true });
    expect(denied.acks[0]).toMatchObject({ ok: false, code: "not_permitted" });

    await s.commands.handle({ type: "set_auto_acquire", commandId: "s3", origin: ORIGIN, enabled: true, expectedEnabled: false, acknowledgeRisk: true });
    expect(s.acks[1]).toMatchObject({ ok: true, revision: 0, approvalRevision: store.approvalRevision });
    expect(store.originPolicy(ORIGIN)).toMatchObject({ autoAcquire: true });
    // Turning it off needs neither.
    await denied.commands.handle({ type: "set_auto_acquire", commandId: "s4", origin: ORIGIN, enabled: false, expectedEnabled: true, acknowledgeRisk: false });
    expect(denied.acks[1]).toMatchObject({ ok: true });
    expect(store.originPolicy(ORIGIN)).toBeUndefined();
  });

  it("the browser-context grant rewrites config.json, keeping other keys, and is announced", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ chromeBundleId: "com.google.chrome.for.testing", destinations: ["docs.stripe.com"], future: { x: 1 } }));
    const s = setup();
    await s.commands.handle({ type: "set_agent_browser_context", commandId: "g1", enabled: true, expectedEnabled: false });
    expect(s.acks[0]).toMatchObject({ ok: true, revision: 0 });
    expect(s.grants).toEqual([true]);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg).toEqual({ chromeBundleId: "com.google.chrome.for.testing", destinations: ["docs.stripe.com"], future: { x: 1 }, agentBrowserContext: true });
    expect(readConfig(home).agentBrowserContext).toBe(true);
    await s.commands.handle({ type: "set_agent_browser_context", commandId: "g2", enabled: false, expectedEnabled: true });
    expect(readConfig(home).agentBrowserContext).toBe(false);
    expect(s.grants).toEqual([true, false]);
  });

  it("an enable the agent API does not read back acks invalid and announces what it reads", async () => {
    // Another invalid key makes the agent API treat the whole file as not granted.
    writeFileSync(join(home, "config.json"), JSON.stringify({ chromeBundleId: 7 }));
    const s = setup();
    await s.commands.handle({ type: "set_agent_browser_context", commandId: "g1", enabled: true, expectedEnabled: false });
    expect(s.acks[0]).toEqual({ type: "ack", commandId: "g1", ok: false, code: "invalid" });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ chromeBundleId: 7, agentBrowserContext: true });
    expect(readBrowserContextGrant(home)).toBe(false);
    expect(s.grants).toEqual([false]);
  });

  it("a malformed config.json is left alone and the grant command fails", async () => {
    writeFileSync(join(home, "config.json"), "[1,2]");
    const s = setup();
    await s.commands.handle({ type: "set_agent_browser_context", commandId: "g1", enabled: true, expectedEnabled: false });
    expect(s.acks[0]).toMatchObject({ ok: false, code: "store_error" });
    expect(s.grants).toEqual([]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("[1,2]");
  });

  it("approve or decline of a version the resource does not record is not_found", async () => {
    const t = await ingest("guide v1");
    const s = setup();
    const version = sha("never recorded");
    await s.commands.handle(approve("a1", { resourceId: t.resourceId, version }, rev(t.resourceId)));
    await s.commands.handle({ type: "decline", commandId: "d1", resourceId: t.resourceId, version, expectedRevision: rev(t.resourceId) });
    expect(s.acks).toEqual([
      { type: "ack", commandId: "a1", ok: false, code: "not_found", revision: rev(t.resourceId) },
      { type: "ack", commandId: "d1", ok: false, code: "not_found", revision: rev(t.resourceId) },
    ]);
    expect(s.counts.approve).toBe(0);
  });

  it("revoke's revision is checked inside the store queue", async () => {
    const t = await ingest("guide v1");
    const seen = rev(t.resourceId);
    // A decision queued ahead of the revoke moves the revision after the command's own check would have run.
    const ahead = store.decline({ ...t, expectedRevision: seen });
    const s = setup();
    const revoking = s.commands.handle({ type: "revoke", commandId: "r1", resourceId: t.resourceId, expectedRevision: seen });
    await Promise.all([ahead, revoking]);
    expect(rev(t.resourceId)).toBe(seen + 1);
    expect(s.acks).toEqual([{ type: "ack", commandId: "r1", ok: false, code: "stale_revision", revision: seen + 1 }]);
    expect(store.getResource(t.resourceId)!.resource.blocked).toBe(false);
  });

  describe("consent toggles are compare-and-set", () => {
    const autoAcquire = (commandId: string, enabled: boolean, expectedEnabled: boolean): MutationCommand => ({
      type: "set_auto_acquire",
      commandId,
      origin: ORIGIN,
      enabled,
      expectedEnabled,
      acknowledgeRisk: enabled,
    });
    const grant = (commandId: string, enabled: boolean, expectedEnabled: boolean): MutationCommand => ({
      type: "set_agent_browser_context",
      commandId,
      enabled,
      expectedEnabled,
    });

    it("auto-acquire: a mismatch is stale_revision and writes nothing; a match applies", async () => {
      const s = setup();
      await s.commands.handle(autoAcquire("s1", true, true));
      expect(s.acks[0]).toEqual({ type: "ack", commandId: "s1", ok: false, code: "stale_revision" });
      expect(s.counts.policy).toBe(0);
      expect(store.originPolicy(ORIGIN)).toBeUndefined();
      await s.commands.handle(autoAcquire("s2", true, false));
      expect(s.acks[1]).toMatchObject({ ok: true });
      expect(store.originPolicy(ORIGIN)).toMatchObject({ autoAcquire: true });
      const before = store.approvalRevision;
      await s.commands.handle(autoAcquire("s3", false, false));
      expect(s.acks[2]).toEqual({ type: "ack", commandId: "s3", ok: false, code: "stale_revision" });
      expect(store.originPolicy(ORIGIN)).toMatchObject({ autoAcquire: true });
      expect(store.approvalRevision).toBe(before);
    });

    it("auto-acquire: the comparison also runs inside the store queue", async () => {
      const s = setup();
      // Two enables the user sent from the same off state: only the first applies.
      await Promise.all([s.commands.handle(autoAcquire("s1", true, false)), s.commands.handle(autoAcquire("s2", true, false))]);
      expect(s.acks.map((a) => (a.ok ? "ok" : a.code))).toEqual(["ok", "stale_revision"]);
      // Both passed the early check; the store refused the second.
      expect(s.counts.policy).toBe(2);
      expect(store.originPolicy(ORIGIN)).toMatchObject({ autoAcquire: true });
    });

    it("auto-acquire: a retried toggle is stale once applied, even with the ID cache cleared", async () => {
      const s = setup();
      await s.commands.handle(autoAcquire("on1", true, false));
      // A fresh command executor on the same store stands in for a core restart.
      const retryOn = setup();
      await retryOn.commands.handle(autoAcquire("on1", true, false));
      expect(retryOn.acks[0]).toEqual({ type: "ack", commandId: "on1", ok: false, code: "stale_revision" });
      await s.commands.handle(autoAcquire("off1", false, true));
      expect(store.originPolicy(ORIGIN)).toBeUndefined();
      const retryOff = setup();
      await retryOff.commands.handle(autoAcquire("off1", false, true));
      expect(retryOff.acks[0]).toEqual({ type: "ack", commandId: "off1", ok: false, code: "stale_revision" });
      expect(retryOn.counts.policy + retryOff.counts.policy).toBe(0);
    });

    it("browser context: a mismatch is stale_revision and writes nothing; a match applies", async () => {
      const s = setup();
      await s.commands.handle(grant("g1", true, true));
      expect(s.acks[0]).toEqual({ type: "ack", commandId: "g1", ok: false, code: "stale_revision" });
      expect(() => readFileSync(join(home, "config.json"))).toThrow();
      expect(s.grants).toEqual([]);
      await s.commands.handle(grant("g2", true, false));
      expect(s.acks[1]).toMatchObject({ ok: true });
      expect(readBrowserContextGrant(home)).toBe(true);
      await s.commands.handle(grant("g3", false, false));
      expect(s.acks[2]).toMatchObject({ ok: false, code: "stale_revision" });
      expect(readBrowserContextGrant(home)).toBe(true);
    });

    it("browser context: a retried toggle is stale once applied, even with the ID cache cleared", async () => {
      const s = setup();
      await s.commands.handle(grant("on1", true, false));
      const retryOn = setup();
      await retryOn.commands.handle(grant("on1", true, false));
      expect(retryOn.acks[0]).toEqual({ type: "ack", commandId: "on1", ok: false, code: "stale_revision" });
      await s.commands.handle(grant("off1", false, true));
      const retryOff = setup();
      await retryOff.commands.handle(grant("off1", false, true));
      expect(retryOff.acks[0]).toEqual({ type: "ack", commandId: "off1", ok: false, code: "stale_revision" });
      expect(readBrowserContextGrant(home)).toBe(false);
      expect(retryOn.grants.concat(retryOff.grants)).toEqual([]);
    });

    it("browser context: an open agent connection sees the toggle on its next current_site", async () => {
      const clockNow = { now: () => now };
      const handlers = createAgentHandlers({
        coreInstanceId: "core-test",
        auth: createAgentAuth({ interactiveToken: "tok" }),
        store,
        view: () => ({ currentSite: { origin: ORIGIN, url: `${ORIGIN}/a`, visitEpoch: 1 }, paused: false }),
        catalog: createCatalogCache({ clock: clockNow, dir: join(home, "cache", "catalog") }),
        browserContextGranted: () => readBrowserContextGrant(home),
        audit: createReadAudit(),
        clock: clockNow,
      });
      let n = 0;
      const call = (method: "hello" | "current_site", params: object, conn: AgentConnection) =>
        handlers.call({ protocol: 1, requestId: `q${++n}`, method, params }, conn) as { status: string; error?: { code: string } };
      const conn: AgentConnection = { id: "c1", principal: null };
      expect(call("hello", { token: "tok" }, conn).status).toBe("ok");
      expect(call("current_site", {}, conn)).toMatchObject({ status: "error", error: { code: "not_granted" } });
      const s = setup();
      await s.commands.handle(grant("g1", true, false));
      expect(call("current_site", {}, conn)).toMatchObject({ status: "ok", result: { site: { origin: ORIGIN } } });
      await s.commands.handle(grant("g2", false, true));
      expect(call("current_site", {}, conn)).toMatchObject({ status: "error", error: { code: "not_granted" } });
    });
  });

  it("refresh_capabilities refreshes and acks", async () => {
    const s = setup();
    await s.commands.handle({ type: "refresh_capabilities", commandId: "f1" });
    expect(s.counts.refresh).toBe(1);
    expect(s.acks[0]).toMatchObject({ ok: true, revision: 0 });
  });

  it("a closed store answers unavailable", async () => {
    const t = await ingest("guide v1");
    await store.close();
    const s = setup();
    await s.commands.handle(approve("a1", t, rev(t.resourceId)));
    expect(s.acks[0]).toMatchObject({ ok: false, code: "unavailable" });
  });
});
