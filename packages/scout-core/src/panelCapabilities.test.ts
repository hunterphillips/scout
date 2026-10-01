import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES_FRAME_MAX_BYTES,
  CAPABILITY_CONFLICTS_MAX,
  CAPABILITY_LIBRARY_MAX,
  CAPABILITY_OFFERS_MAX,
  LIBRARY_VERSIONS_MAX,
  type PanelCapabilities,
  PanelStateSchema,
  type ResourceKind,
  SOURCE_URL_MAX_CHARS,
} from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoreState } from "./capabilities/decisions.js";
import type { DiscoveryResult, ProbeItem } from "./capabilities/discovery.js";
import { type CapabilityStore, createCapabilityStore } from "./capabilities/store.js";
import type { Timers } from "./clock.js";
import { buildCapabilities, type CapabilitiesInput, createCapabilitiesEmitter } from "./panelCapabilities.js";

const A = "https://a.example";
const B = "https://b.example";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function discovery(origin: string, found: { path: string; text: string; kind?: ResourceKind; skill?: { name: string; description?: string } }[]): DiscoveryResult {
  const items: ProbeItem[] = found.map((f) => {
    const kind = f.kind ?? "llms_txt";
    const sourceUrl = `${origin}${f.path}`;
    return {
      kind,
      sourceUrl,
      status: "found",
      source: "network",
      resource: {
        kind,
        siteOrigin: origin,
        publisherOrigin: origin,
        sourceUrl,
        finalUrl: sourceUrl,
        text: f.text,
        sha256: sha(f.text),
        byteLength: Buffer.byteLength(f.text),
        fetchedAt: now,
        ...(f.skill ? { skill: { ...f.skill, sha256: sha(f.text) } } : {}),
      },
    };
  });
  return { origin, checkedAt: now, robots: "not_fetched", items, externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } };
}

let home: string;
let now: number;
let store: CapabilityStore;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "scout-panelcaps-"));
  now = 1_800_000_000_000;
  store = await createCapabilityStore({ scoutHome: home, clock: { now: () => now } });
});
afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

const input = (permitted: string[], extra: Partial<CapabilitiesInput> = {}): CapabilitiesInput => ({
  state: store.snapshot(),
  conflicts: [],
  isPermitted: (o) => permitted.includes(o),
  currentOrigin: null,
  ...extra,
});

async function ingest(origin: string, path: string, text: string, extra: { kind?: ResourceKind; skill?: { name: string; description?: string } } = {}) {
  const r = (await store.ingest(discovery(origin, [{ path, text, ...extra }]), { chromePermitted: false })).results[0]!;
  return { id: r.resourceId, version: r.version };
}
const rev = (id: string) => store.getResource(id)!.revision;

describe("buildCapabilities", () => {
  it("offers only pending versions of unblocked resources on permitted origins", async () => {
    const skill = await ingest(A, "/skills/s.md", "skill text", { kind: "skill", skill: { name: "s", description: "does s" } });
    const other = await ingest(B, "/llms.txt", "b guide");
    const declined = await ingest(A, "/llms.txt", "a guide v1");
    await store.decline({ resourceId: declined.id, version: declined.version, expectedRevision: rev(declined.id) });
    const revoked = await ingest(A, "/AGENTS.md", "agents v1", { kind: "agents_md" });
    await store.revoke(revoked.id);
    // Rediscovering a revoked resource with new text records a version but never offers it.
    await ingest(A, "/AGENTS.md", "agents v2", { kind: "agents_md" });

    const body = buildCapabilities(input([A]));
    expect(body.offers).toEqual([
      {
        resourceId: skill.id,
        version: skill.version,
        kind: "skill",
        siteOrigin: A,
        sourceUrl: `${A}/skills/s.md`,
        byteLength: 10,
        fetchedAt: now,
        resourceRevision: rev(skill.id),
        skill: { name: "s", description: "does s" },
      },
    ]);
    // Losing A's grant and gaining B's moves the offers.
    expect(buildCapabilities(input([B])).offers.map((o) => o.resourceId)).toEqual([other.id]);
    expect(buildCapabilities(input([])).offers).toEqual([]);

    const states = Object.fromEntries(body.library.map((l) => [l.resourceId, l.state]));
    expect(states).toEqual({ [skill.id]: "no_default", [other.id]: "no_default", [declined.id]: "no_default", [revoked.id]: "blocked" });
    expect(body.truncated).toBe(false);
    const frame: PanelCapabilities = { type: "capabilities", revision: 1, ...body };
    expect(PanelStateSchema.safeParse(frame).success).toBe(true);
  });

  it("offers only a resource's newest version, and only while it is pending", async () => {
    const v1 = await ingest(A, "/llms.txt", "guide v1");
    now += 1000;
    const v2 = await ingest(A, "/llms.txt", "guide v2");
    expect(store.getResource(v1.id)!.resource.versions.map((v) => v.state)).toEqual(["pending", "pending"]);
    expect(buildCapabilities(input([A])).offers.map((o) => o.version)).toEqual([v2.version]);

    // An older pending version behind a declined newer one is not offered.
    await store.decline({ resourceId: v2.id, version: v2.version, expectedRevision: rev(v2.id) });
    expect(store.getVersion(v1.id, v1.version)!.state).toBe("pending");
    expect(buildCapabilities(input([A])).offers).toEqual([]);
  });

  it("lists library versions newest first, with the default and revision", async () => {
    let first: { id: string; version: string } | undefined;
    for (let i = 0; i < 8; i++) {
      now += 1000;
      const v = await ingest(A, "/llms.txt", `guide v${i}`);
      first ??= v;
    }
    await store.approve({ resourceId: first!.id, version: store.getResource(first!.id)!.resource.versions.at(-1)!.hash, expectedRevision: rev(first!.id) });
    const entry = buildCapabilities(input([A])).library[0]!;
    expect(entry.state).toBe("approved");
    // The store keeps five unpinned versions; the frame would show up to six.
    expect(entry.versions).toHaveLength(store.getResource(first!.id)!.resource.versions.length);
    expect(entry.versions[0]!.hash).toBe(entry.defaultVersion);
    expect(entry.versions.map((v) => v.fetchedAt)).toEqual([...entry.versions.map((v) => v.fetchedAt)].sort((a, b) => b - a));
    expect(entry.resourceRevision).toBe(rev(first!.id));
  });

  it("bounds offers and library and says so", () => {
    const base = store.snapshot();
    const resources: StoreState["resources"] = [];
    for (let i = 0; i < CAPABILITY_LIBRARY_MAX + 5; i++) {
      const hash = sha(`v${i}`);
      const sourceUrl = `${A}/r${i}.md`;
      resources.push({
        resource: { id: `res_${sha(`r${i}`)}`, kind: "llms_txt", siteOrigin: A, publisherOrigin: A, sourceUrl, versions: [{ hash, blobRef: hash, byteLength: 1, fetchedAt: i, state: "pending" }], blocked: false },
        revision: 1,
        meta: { [hash]: { lastSeenAt: i } },
      });
    }
    const body = buildCapabilities({ state: { ...base, resources }, conflicts: [], isPermitted: () => true, currentOrigin: null });
    expect(body.offers).toHaveLength(CAPABILITY_OFFERS_MAX);
    expect(body.library).toHaveLength(CAPABILITY_LIBRARY_MAX);
    expect(body.truncated).toBe(true);
    // Newest first.
    expect(body.offers[0]!.fetchedAt).toBe(CAPABILITY_LIBRARY_MAX + 4);

    const many = structuredClone(resources[0]!);
    for (let i = 0; i < 8; i++) {
      const hash = sha(`many${i}`);
      many.resource.versions.push({ hash, blobRef: hash, byteLength: 1, fetchedAt: 1000 + i, state: "declined", decision: { actor: "user", at: 1 } });
      many.meta[hash] = { lastSeenAt: 1 };
    }
    const entry = buildCapabilities({ state: { ...base, resources: [many] }, conflicts: [], isPermitted: () => true, currentOrigin: null }).library[0]!;
    expect(entry.versions.map((v) => v.fetchedAt)).toEqual([1007, 1006, 1005, 1004, 1003, 1002]);

    // A default older than the six newest is still listed, in place of the oldest other one.
    const old = structuredClone(many);
    old.resource.versions[0]!.state = "approved";
    old.resource.defaultVersion = old.resource.versions[0]!.hash;
    const withDefault = buildCapabilities({ state: { ...base, resources: [old] }, conflicts: [], isPermitted: () => true, currentOrigin: null }).library[0]!;
    expect(withDefault.versions).toHaveLength(LIBRARY_VERSIONS_MAX);
    expect(withDefault.versions.map((v) => v.fetchedAt)).toEqual([1007, 1006, 1005, 1004, 1003, old.resource.versions[0]!.fetchedAt]);
    expect(withDefault.versions.at(-1)!.hash).toBe(withDefault.defaultVersion);
  });

  it("keeps the serialized frame under its byte budget at maximum field sizes", () => {
    const base = store.snapshot();
    // A 253-character hostname, distinct per resource.
    const host = (i: number) => [`h${i}`.padEnd(63, "a"), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    const resources: StoreState["resources"] = [];
    for (let i = 0; i < CAPABILITY_LIBRARY_MAX; i++) {
      const origin = `https://${host(i)}`;
      const prefix = `${origin}/`;
      const sourceUrl = prefix + "p".repeat(SOURCE_URL_MAX_CHARS - prefix.length);
      const versions: StoreState["resources"][number]["resource"]["versions"] = [];
      const meta: StoreState["resources"][number]["meta"] = {};
      for (let j = 0; j < LIBRARY_VERSIONS_MAX; j++) {
        const hash = sha(`r${i}v${j}`);
        // The newest version of the first CAPABILITY_OFFERS_MAX resources is a pending skill (an offer).
        const pending = j === LIBRARY_VERSIONS_MAX - 1 && i < CAPABILITY_OFFERS_MAX;
        versions.push({ hash, blobRef: hash, byteLength: 131072, fetchedAt: i * 10 + j, state: pending ? "pending" : "declined", ...(pending ? {} : { decision: { actor: "user" as const, at: 1 } }) });
        meta[hash] = { lastSeenAt: 1, ...(pending ? { skill: { name: "s".repeat(256), description: "d".repeat(4096), digest: hash } } : {}) };
      }
      resources.push({ resource: { id: `res_${sha(`r${i}`)}`, kind: "skill", siteOrigin: origin, publisherOrigin: origin, sourceUrl, versions, blocked: false }, revision: 99, meta });
    }
    const conflicts = Array.from({ length: CAPABILITY_CONFLICTS_MAX }, (_, i) => ({ name: `scout-skill-${sha(`c${i}`).slice(0, 16)}`, resourceId: resources[i]!.resource.id, code: "foreign_collision" as const }));
    const unbounded = (() => {
      const body = buildCapabilities({ state: { ...base, resources: resources.slice(0, 1) }, conflicts: [], isPermitted: () => true, currentOrigin: null });
      return Buffer.byteLength(JSON.stringify(body.library[0])) * CAPABILITY_LIBRARY_MAX;
    })();
    expect(unbounded).toBeGreaterThan(CAPABILITIES_FRAME_MAX_BYTES);

    const body = buildCapabilities({ state: { ...base, resources }, conflicts, isPermitted: () => true, currentOrigin: null });
    const frame: PanelCapabilities = { type: "capabilities", revision: Number.MAX_SAFE_INTEGER, ...body };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(CAPABILITIES_FRAME_MAX_BYTES);
    expect(body.truncated).toBe(true);
    expect(PanelStateSchema.safeParse(frame).success).toBe(true);
    // The least recent library entries went first; every kept entry is whole.
    expect(body.library.length).toBeLessThan(CAPABILITY_LIBRARY_MAX);
    expect(body.library[0]!.resourceId).toBe(resources.at(-1)!.resource.id);
    expect(body.library.every((l) => l.versions.length === LIBRARY_VERSIONS_MAX)).toBe(true);
    expect(body.conflicts).toHaveLength(CAPABILITY_CONFLICTS_MAX);

    // A normal frame is untouched.
    const small = buildCapabilities({ state: { ...base, resources: resources.slice(0, 3) }, conflicts: [], isPermitted: () => true, currentOrigin: null });
    expect(small.truncated).toBe(false);
    expect(small.library).toHaveLength(3);
    expect(small.offers).toHaveLength(3);
  });

  it("carries export conflicts and origin settings", async () => {
    const r = await ingest(A, "/llms.txt", "guide");
    await store.setOriginPolicy({ origin: A, autoAcquire: true, acknowledgeRisk: true });
    const body = buildCapabilities(input([A], { conflicts: [{ name: "scout-skill-0123456789abcdef", resourceId: r.id, code: "foreign_collision" }], currentOrigin: B }));
    expect(body.conflicts).toEqual([{ name: "scout-skill-0123456789abcdef", resourceId: r.id, code: "foreign_collision" }]);
    expect(body.origins).toEqual([
      { origin: A, autoAcquire: true, acknowledgedAt: now, permitted: true },
      { origin: B, autoAcquire: false, permitted: false },
    ]);
  });
});

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
  return { timers, fire, get pending() {
    return pending.size;
  } };
}

describe("capabilities emitter", () => {
  it("coalesces changes, skips unchanged frames, and refresh always sends", async () => {
    const t = fakeTimers();
    const frames: PanelCapabilities[] = [];
    let permitted: string[] = [A];
    const emitter = createCapabilitiesEmitter({ input: () => input(permitted), emit: (f) => void frames.push(f), timers: t.timers });
    emitter.refresh();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.revision).toBe(1);

    await ingest(A, "/llms.txt", "guide");
    emitter.changed();
    emitter.changed();
    expect(frames).toHaveLength(1);
    expect(t.pending).toBe(1);
    t.fire();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.offers).toHaveLength(1);

    // Nothing changed: no frame.
    emitter.changed();
    t.fire();
    expect(frames).toHaveLength(2);

    // A permission loss drops the offer on the next frame.
    permitted = [];
    emitter.changed();
    t.fire();
    expect(frames).toHaveLength(3);
    expect(frames[2]!.offers).toEqual([]);
    expect(frames[2]!.revision).toBe(3);

    emitter.refresh();
    expect(frames).toHaveLength(4);
    emitter.stop();
    emitter.changed();
    emitter.refresh();
    expect(frames).toHaveLength(4);
  });
});
