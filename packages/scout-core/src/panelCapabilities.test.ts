import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_LIBRARY_MAX, CAPABILITY_OFFERS_MAX, type PanelCapabilities, PanelStateSchema, type ResourceKind } from "@scout/contracts";
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
    expect(states).toEqual({ [skill.id]: "pending_only", [other.id]: "pending_only", [declined.id]: "pending_only", [revoked.id]: "blocked" });
    expect(body.truncated).toBe(false);
    const frame: PanelCapabilities = { type: "capabilities", revision: 1, ...body };
    expect(PanelStateSchema.safeParse(frame).success).toBe(true);
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
