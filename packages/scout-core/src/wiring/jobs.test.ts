import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PROFILE_LOCK_FILE } from "../agents/profileCli.js";
import { profileFingerprint, type AgentProfile } from "../agents/profile.js";
import { acquireStoreLock, StoreLockedError } from "../capabilities/storeLock.js";
import { ParseCancelledError } from "../catalog/parseWorker.js";
import { systemClock, type Timers } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { SchedulerProfile } from "../jobScheduler.js";
import { createJobWiring, PROFILE_LOCK_RETRY_MS, type JobWiring } from "./jobs.js";

const ORIGIN = "https://docs.example.com";
const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/a</loc></url></urlset>`;

function profile(home: string, revision?: number): AgentProfile {
  const p: AgentProfile = { schemaVersion: 1, adapter: "claude-code", claudePath: join(home, "bin", "claude"), model: "claude-sonnet-5-5" };
  if (revision !== undefined) p.tools = { revision, connections: [], selections: [] };
  return p;
}

/** Write the profile the way an editor or the CLI does: a 0600 file renamed into place. */
function writeProfile(home: string, content: AgentProfile | string): void {
  const tmp = join(home, ".agent-profile.tmp");
  writeFileSync(tmp, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  renameSync(tmp, join(home, "agent-profile.json"));
}

/** Manual one-shot timers (the lock retry and the watcher's debounce). */
function manualTimers(): Timers & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void due.delete(h as number),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...due.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now || !due.has(id)) continue;
        due.delete(id);
        t.fn();
      }
    },
  };
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("job wiring: process ownership and the agent profile (P3.4)", () => {
  let home: string;
  let wiring: JobWiring | null = null;
  const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };

  const build = (extra: { timers?: Timers } = {}): JobWiring => {
    wiring = createJobWiring({
      home,
      env: {},
      destinations: [],
      coreInstanceId: "core-test",
      clock: systemClock,
      diagnostics,
      results: {} as never,
      snapshots: () => null,
      coordinator: () => {
        throw new Error("no job runs in these tests");
      },
      activity: { entries: () => [] },
      store: { approvalRevision: 0 },
      ...extra,
    });
    return wiring;
  };

  afterEach(async () => {
    await wiring?.close();
    wiring = null;
    events.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  const fresh = (): void => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "swj-")));
    chmodSync(home, 0o700);
  };

  it("holds agent-profile.lock for its lifetime (a profile CLI write is refused) and releases it on close", async () => {
    fresh();
    const w = build();
    expect(w.holdsProfileLock).toBe(true);
    expect(() => acquireStoreLock(home, { now: () => Date.now(), file: AGENT_PROFILE_LOCK_FILE })).toThrow(StoreLockedError);
    await w.close();
    const lock = acquireStoreLock(home, { now: () => Date.now(), file: AGENT_PROFILE_LOCK_FILE });
    lock.release();
  });

  it("a lock held elsewhere at start is reported and retried until it is free; start is never blocked", () => {
    fresh();
    const other = acquireStoreLock(home, { now: () => Date.now(), file: AGENT_PROFILE_LOCK_FILE });
    const timers = manualTimers();
    const w = build({ timers });
    expect(w.holdsProfileLock).toBe(false);
    expect(events.find((e) => e.name === "agent_profile_lock_busy")?.fields).toEqual({ code: "locked" });
    timers.advance(PROFILE_LOCK_RETRY_MS);
    expect(w.holdsProfileLock).toBe(false);
    other.release();
    timers.advance(PROFILE_LOCK_RETRY_MS);
    expect(w.holdsProfileLock).toBe(true);
  });

  it("an edited profile (new tools revision) swaps the adapter for the next job, tells the scheduler, and closes the old adapter", async () => {
    fresh();
    writeProfile(home, profile(home, 1));
    const w = build();
    const first = w.adapter!;
    expect(first.profileFingerprint).toBe(profileFingerprint(profile(home, 1)));
    const seen: Array<string | SchedulerProfile> = [];
    w.scheduler.onProfileChanged = (next) => void seen.push(next);

    // Rewriting the same content changes nothing.
    writeProfile(home, profile(home, 1));
    await new Promise((r) => setTimeout(r, 600));
    expect(seen).toEqual([]);

    writeProfile(home, profile(home, 2));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ fingerprint: profileFingerprint(profile(home, 2)), toolsRevision: 2, hasUserTools: false });
    expect(w.adapter).not.toBe(first);
    expect(w.adapter!.profileFingerprint).toBe(profileFingerprint(profile(home, 2)));
    expect(events.find((e) => e.name === "agent_profile_changed")?.fields).toEqual({ usable: true, toolsRevision: 2 });
    // The replaced adapter is closed: it runs no further job.
    const out = await first.run(
      { requestId: "r1", coreInstanceId: "core-test", visitEpoch: 1, origin: ORIGIN, catalogHash: "c", browserSnapshot: { id: "s", revision: 1 }, approvalRevision: 0, grantRevision: 0, profileFingerprint: first.profileFingerprint, deadlineMs: 20_000, candidates: [{ id: "c1", title: "A", labelQuality: "published" }], maxPicks: 3 },
      { toolSurface: { scout: { socketPath: join(home, "run", "agent.sock"), token: "x".repeat(43) } } },
    );
    expect(out.result).toMatchObject({ status: "unavailable", reason: "agent_unavailable" });

    // An edit that breaks the profile leaves no adapter (jobs are unavailable); fixing it brings one back.
    writeProfile(home, "{not json");
    await until(() => seen.length === 2);
    expect(w.adapter).toBeNull();
    expect(seen[1]).toEqual({ fingerprint: "none", toolsRevision: 0, hasUserTools: false });
    writeProfile(home, profile(home, 3));
    await until(() => seen.length === 3);
    expect(w.adapter?.profileFingerprint).toBe(profileFingerprint(profile(home, 3)));
  });

  it("no change is acted on after close", async () => {
    fresh();
    writeProfile(home, profile(home, 1));
    const w = build();
    const seen: unknown[] = [];
    w.scheduler.onProfileChanged = (next) => void seen.push(next);
    await w.close();
    writeProfile(home, profile(home, 2));
    await new Promise((r) => setTimeout(r, 600));
    expect(seen).toEqual([]);
  });

  it("a cancelled pass's parses are refused before they reach the worker; another pass's still run", async () => {
    fresh();
    const w = build();
    const a = w.createFetchSession(ORIGIN);
    const b = w.createFetchSession(ORIGIN);
    a.cancel();
    expect(a.isCancelled()).toBe(true);
    await expect(w.parsersFor(a).sitemap(SITEMAP, ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
    const parsed = await w.parsersFor(b).sitemap(SITEMAP, ORIGIN);
    expect(parsed.kind).toBe("urlset");
    await w.closeParsers();
    await expect(w.parsersFor(b).sitemap(SITEMAP, ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
  });
});
