import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEntry, Candidate } from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentAuth, createAgentAuth } from "../agentApi/auth.js";
import type { DiscoveryResult } from "../capabilities/discovery.js";
import { type CapabilityStore, createCapabilityStore } from "../capabilities/store.js";
import type { DiagnosticFields, Diagnostics } from "../diagnostics.js";
import { createSnapshotRegistry, type SnapshotRegistry, snapshotCandidates, type TakeSnapshotInput } from "./snapshots.js";

const SITE = "https://docs.example.com";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let home: string;
let now: number;
let store: CapabilityStore;
let auth: AgentAuth;
let registry: SnapshotRegistry;
let events: Array<{ name: string; fields: DiagnosticFields }>;

function discovery(path: string, text: string): DiscoveryResult {
  const sourceUrl = `${SITE}${path}`;
  return {
    origin: SITE,
    checkedAt: now,
    robots: "not_fetched",
    items: [
      {
        kind: "llms_txt",
        sourceUrl,
        status: "found",
        source: "network",
        resource: { kind: "llms_txt", siteOrigin: SITE, publisherOrigin: SITE, sourceUrl, finalUrl: sourceUrl, text, sha256: sha(text), byteLength: Buffer.byteLength(text), fetchedAt: now },
      },
    ],
    externalReferences: [],
    skillsOverCap: 0,
    acceptedBytes: 0,
    stats: { requests: 0, refused: 0, ms: 0 },
  };
}

async function approved(path: string, text: string) {
  const r = (await store.ingest(discovery(path, text), { chromePermitted: false })).results[0]!;
  await store.approve({ resourceId: r.resourceId, version: r.version, expectedRevision: store.getResource(r.resourceId)!.revision });
  return { id: r.resourceId, version: r.version };
}

const ACTIVITY: ActivityEntry[] = [
  { origin: "https://github.com", url: "https://github.com/o/r/issues/1", observedAt: 5, title: "Issue", text: "Body", textTruncated: false },
];
const CANDIDATES: Candidate[] = [
  { id: "c0", sourceUrl: `${SITE}/a.md`, humanHref: `${SITE}/a`, title: "A", labelQuality: "published", provenance: "llms.txt" },
  { id: "c1", sourceUrl: `${SITE}/b`, title: "B", description: "About B", labelQuality: "slug", provenance: "sitemap" },
];

const input = (overrides: Partial<TakeSnapshotInput> = {}): TakeSnapshotInput => ({
  jobId: "job-1",
  origin: SITE,
  visitEpoch: 3,
  activity: ACTIVITY,
  candidates: snapshotCandidates(CANDIDATES),
  catalogHash: "cat-hash",
  permissionsRevision: 9,
  profileFingerprint: "profile-fp",
  deadline: now + 30_000,
  ...overrides,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "scout-snap-"));
  now = 1_800_000_000_000;
  const clock = { now: () => now };
  store = await createCapabilityStore({ scoutHome: home, clock });
  auth = createAgentAuth({ interactiveToken: "interactive", clock });
  events = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  registry = createSnapshotRegistry({ store, auth, clock, diagnostics });
});
afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("snapshot registry", () => {
  it("records the job's inputs, every approved default version, and the store's approval revision", async () => {
    const a = await approved("/llms.txt", "guide\n");
    const b = await approved("/AGENTS.md", "agents\n");
    const { snapshot, token } = registry.take(input());
    expect(snapshot.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(snapshot).toMatchObject({
      revision: 1,
      jobId: "job-1",
      origin: SITE,
      visitEpoch: 3,
      activity: ACTIVITY,
      catalogHash: "cat-hash",
      approvalRevision: store.approvalRevision,
      permissionsRevision: 9,
      profileFingerprint: "profile-fp",
      deadline: now + 30_000,
    });
    expect(snapshot.candidates).toEqual([
      { id: "c0", title: "A", labelQuality: "published", href: `${SITE}/a` },
      { id: "c1", title: "B", description: "About B", labelQuality: "slug", href: `${SITE}/b` },
    ]);
    expect([...snapshot.approved].sort((x, y) => x.resourceId.localeCompare(y.resourceId))).toEqual(
      [{ resourceId: a.id, version: a.version }, { resourceId: b.id, version: b.version }].sort((x, y) => x.resourceId.localeCompare(y.resourceId)),
    );
    expect(auth.verify(token)).toMatchObject({ role: "job", jobId: "job-1", origin: SITE, visitEpoch: 3 });
    expect(registry.get(snapshot.id)).toBe(snapshot);
    expect(registry.getForJob("job-1")).toBe(snapshot);
    expect(events).toEqual([{ name: "snapshot_taken", fields: { activity: 1, candidates: 2, approved: 2 } }]);
  });

  it("is deeply frozen: a mutation throws and the registry still holds the original", () => {
    const activity = ACTIVITY.map((e) => ({ ...e }));
    const { snapshot } = registry.take(input({ activity }));
    expect(() => {
      (snapshot as { catalogHash: string }).catalogHash = "x";
    }).toThrow(TypeError);
    expect(() => (snapshot.activity as ActivityEntry[]).push(ACTIVITY[0]!)).toThrow(TypeError);
    expect(() => {
      (snapshot.activity[0] as { title: string }).title = "x";
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.candidates[0] as { href: string }).href = "x";
    }).toThrow(TypeError);
    // The caller's own arrays are copied, not frozen, and changing them changes nothing here.
    activity[0]!.title = "changed later";
    expect(Object.isFrozen(activity)).toBe(false);
    expect(registry.get(snapshot.id)!.activity[0]!.title).toBe("Issue");
    expect(registry.get(snapshot.id)!.catalogHash).toBe("cat-hash");
  });

  it("holds its versions' pins against collection until it is released", async () => {
    const v1 = await approved("/llms.txt", "guide v1\n");
    const { snapshot } = registry.take(input());
    // More newer approvals than collection retains: v1 is collectable unless pinned.
    for (let i = 2; i <= 8; i++) {
      now += 1000;
      await approved("/llms.txt", `guide v${i}\n`);
    }
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version).ok).toBe(true);
    expect(snapshot.approved).toEqual([{ resourceId: v1.id, version: v1.version }]);

    registry.release(snapshot.id, "cancelled");
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version)).toEqual({ ok: false, code: "not_found" });
    expect(events.at(-1)).toEqual({ name: "job_token_revoked", fields: { reason: "cancelled" } });
  });

  it("issues a token that expires at the job's deadline", () => {
    const { token } = registry.take(input({ deadline: now + 10_000 }));
    const principal = auth.verify(token)!;
    now += 9_999;
    expect(auth.isCurrent(principal)).toBe(true);
    now += 1;
    expect(auth.isCurrent(principal)).toBe(false);
    expect(auth.verify(token)).toBeNull();
  });

  it("a replacement job gets a new snapshot and token; the old one stays readable until released", () => {
    const first = registry.take(input({ jobId: "job-1" }));
    const second = registry.take(input({ jobId: "job-2", activity: [] }));
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.snapshot.revision).toBe(first.snapshot.revision + 1);
    expect(second.token).not.toBe(first.token);
    const p1 = auth.verify(first.token)!;
    expect(registry.get(first.snapshot.id)!.activity).toHaveLength(1);
    expect(auth.isCurrent(p1)).toBe(true);
    registry.release(first.snapshot.id);
    expect(auth.isCurrent(p1)).toBe(false);
    expect(registry.get(first.snapshot.id)).toBeUndefined();
    expect(registry.getForJob("job-1")).toBeUndefined();
    expect(auth.verify(second.token)).not.toBeNull();
  });

  it("refuses a second snapshot for a job that already holds one", async () => {
    await approved("/llms.txt", "guide\n");
    registry.take(input());
    expect(() => registry.take(input())).toThrow();
    expect(registry.size).toBe(1);
  });

  it("releasePinning releases only the snapshots that pinned the resource, with their pins on every other resource", async () => {
    const a = await approved("/llms.txt", "guide v1\n");
    const kept = registry.take(input({ jobId: "kept" }));
    const other = await approved("/AGENTS.md", "agents\n");
    const pinning = registry.take(input({ jobId: "pinning", activity: [] }));
    expect(kept.snapshot.approved.map((v) => v.resourceId)).toEqual([a.id]);
    expect(pinning.snapshot.approved.map((v) => v.resourceId).sort()).toEqual([a.id, other.id].sort());
    // Supersede a's first version past what collection retains: only pins keep it.
    for (let i = 2; i <= 8; i++) {
      now += 1000;
      await approved("/llms.txt", `guide v${i}\n`);
    }
    registry.releasePinning(other.id, "revoked");
    expect(registry.get(pinning.snapshot.id)).toBeUndefined();
    expect(auth.verify(pinning.token)).toBeNull();
    expect(registry.get(kept.snapshot.id)).toBeDefined();
    expect(auth.verify(kept.token)).not.toBeNull();
    expect(events.at(-1)).toEqual({ name: "job_token_revoked", fields: { reason: "revoked" } });

    await store.collectGarbage();
    expect(store.resolveRead(a.id, a.version).ok).toBe(true);
    // Once the surviving snapshot goes too, nothing pins a's first version.
    registry.release(kept.snapshot.id);
    await store.collectGarbage();
    expect(store.resolveRead(a.id, a.version)).toEqual({ ok: false, code: "not_found" });
  });

  it("take refuses while paused and for good after releaseAll(shutdown)", () => {
    let paused = true;
    const guarded = createSnapshotRegistry({ store, auth, clock: { now: () => now }, paused: () => paused });
    expect(() => guarded.take(input({ jobId: "p" }))).toThrow("paused");
    paused = false;
    guarded.take(input({ jobId: "p" }));
    guarded.releaseAll("paused");
    guarded.take(input({ jobId: "q" }));
    guarded.releaseAll("shutdown");
    expect(() => guarded.take(input({ jobId: "r" }))).toThrow("shut down");
    expect(guarded.size).toBe(0);
  });

  it("releaseAll revokes every job token and releases every snapshot; sweepExpired only the expired ones", () => {
    const a = registry.take(input({ jobId: "a", deadline: now + 1_000 }));
    const b = registry.take(input({ jobId: "b", deadline: now + 60_000 }));
    now += 1_000;
    registry.sweepExpired();
    expect(registry.get(a.snapshot.id)).toBeUndefined();
    expect(registry.get(b.snapshot.id)).toBeDefined();
    registry.releaseAll("paused");
    expect(registry.size).toBe(0);
    expect(auth.verify(b.token)).toBeNull();
    expect(events.filter((e) => e.name === "job_token_revoked").map((e) => e.fields)).toEqual([{ reason: "expired" }, { reason: "paused", count: 1 }]);
    // Diagnostics stay scalar: no text, titles or URLs.
    expect(JSON.stringify(events)).not.toMatch(/github|Issue|Body|https?:/);
  });
});
