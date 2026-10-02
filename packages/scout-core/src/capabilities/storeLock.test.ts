import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStoreLock, releaseHeldLocks } from "./storeLock.js";

describe("store lock: release only what is ours, and the synchronous release of held locks", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ssl-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("releaseHeldLocks(dir) releases every lock this process holds under dir, and none elsewhere", () => {
    const other = mkdtempSync(join(tmpdir(), "ssl-other-"));
    try {
      mkdirSync(join(home, "capabilities"));
      acquireStoreLock(join(home, "capabilities"), { now: () => 1 });
      acquireStoreLock(home, { now: () => 1, file: "agent-profile.lock" });
      const outside = acquireStoreLock(other, { now: () => 1 });
      expect(releaseHeldLocks(home)).toBe(2);
      expect(existsSync(join(home, "capabilities", "store.lock"))).toBe(false);
      expect(existsSync(join(home, "agent-profile.lock"))).toBe(false);
      expect(existsSync(join(other, "store.lock"))).toBe(true);
      expect(releaseHeldLocks(home)).toBe(0);
      outside.release();
      expect(existsSync(join(other, "store.lock"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("a release never removes a file that replaced ours, even one carrying our record", () => {
    const lock = acquireStoreLock(home, { now: () => 1 });
    const path = join(home, "store.lock");
    // Same bytes, another inode: not the file we created.
    const copy = join(home, "copy");
    writeFileSync(copy, JSON.stringify({ pid: process.pid, instanceId: lock.instanceId, startedAt: 1 }), { mode: 0o600 });
    renameSync(copy, path);
    lock.release();
    expect(existsSync(path)).toBe(true);
  });
});
