// runCleanup: every step runs even when another throws, and each failure is a fixed code.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanup } from "./cleanup.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function state(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "cln-"));
  dirs.push(root);
  const calls = [];
  const s = {
    label: "acceptance",
    sessions: [{ n: 1 }],
    closeSession: async (i) => {
      calls.push("session");
      s.sessions[i].close = { processesRemaining: 0 };
    },
    skill: { dir: join(root, "skill"), hash: "h" },
    addAttempted: true,
    registered: true,
    removeSkill: () => {
      calls.push("skill");
      return "removed";
    },
    removeRegistration: () => {
      calls.push("registration");
      return { state: "removed" };
    },
    fixture: { openConnections: () => 0, close: async () => void calls.push("fixture") },
    profile: { cleanup: () => void calls.push("profile") },
    throwaway: { root, remove: () => (calls.push("throwaway"), rmSync(root, { recursive: true, force: true })) },
    cleanup: { ok: false },
    failures: [],
    connectionWaitMs: 0,
    ...over,
  };
  return { s, calls };
}

const boom = (code) => () => {
  const e = new Error("contains /Users/someone/secret");
  if (code) e.code = code;
  throw e;
};

describe("runCleanup", () => {
  it("runs every step and is ok when all are clean", async () => {
    const { s, calls } = state();
    const c = await runCleanup(s);
    expect(calls).toEqual(["session", "skill", "registration", "fixture", "profile", "throwaway"]);
    expect(c).toMatchObject({ ok: true, skillDir: "removed", registration: "removed", fixture: "closed", processesRemaining: 0, throwawayRemoved: true });
    expect(s.failures).toEqual([]);
  });

  it("keeps going when every step throws, recording a fixed code per step", async () => {
    const { s, calls } = state({
      closeSession: async () => {
        calls.push("session");
        throw Object.assign(new Error("x"), { code: "ESRCH" });
      },
      removeSkill: () => (calls.push("skill"), boom("EACCES")()),
      removeRegistration: () => (calls.push("registration"), boom()()),
      fixture: { openConnections: () => 0, close: async () => (calls.push("fixture"), boom("EBADF")()) },
      profile: { cleanup: () => (calls.push("profile"), boom("EPERM")()) },
    });
    const throwaway = s.throwaway;
    s.throwaway = { root: throwaway.root, remove: () => (calls.push("throwaway"), boom("EBUSY")()) };
    const c = await runCleanup(s);
    expect(calls).toEqual(["session", "skill", "registration", "fixture", "profile", "throwaway"]);
    expect(s.sessions[0].close).toEqual({ closeFailed: true, error: "error_ESRCH", processesRemaining: null });
    expect(c).toMatchObject({
      ok: false,
      skillDir: "error_EACCES",
      registration: "error_Error",
      fixture: "error_EBADF",
      profileCleanup: "error_EPERM",
      throwawayError: "error_EBUSY",
      throwawayRemoved: false,
      processesRemaining: null,
    });
    expect(JSON.stringify(c)).not.toContain("/Users/someone");
    expect(s.failures).toEqual(["cleanup_incomplete"]);
  });

  it("removes the registration whatever the skill step returned", async () => {
    const { s, calls } = state({ removeSkill: () => (calls.push("skill"), "left_symlink") });
    const c = await runCleanup(s);
    expect(calls).toContain("registration");
    expect(c).toMatchObject({ ok: false, skillDir: "left_symlink", registration: "removed" });
  });

  it("names nothing it was not asked to remove", async () => {
    const { s } = state({ skill: undefined, addAttempted: false, fixture: undefined, profile: undefined });
    const c = await runCleanup(s);
    expect(c).toMatchObject({ ok: true, skillDir: "not_created", registration: "not_registered", fixture: "not_started" });
  });
});
