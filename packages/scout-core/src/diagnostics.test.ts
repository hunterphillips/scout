import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnostics, defaultDiagnosticsPath, scoutHome } from "./diagnostics.js";

const clock = { now: () => 1234 };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "scout-diag-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("diagnostics", () => {
  it("appends one JSON line per event, creating the log directory 0700 on first write", () => {
    const home = tempDir();
    const path = defaultDiagnosticsPath({ SCOUT_HOME: home });
    const diag = createDiagnostics({ path, clock });
    diag.event("visit_change", { epoch: 3, active: true });
    diag.event("resume_miss", { reason: "expired" });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: 1234, event: "visit_change", epoch: 3, active: true },
      { t: 1234, event: "resume_miss", reason: "expired" },
    ]);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
  });

  it("drops privacy-sensitive and reserved fields with a warning", () => {
    const appended: string[] = [];
    const warn = vi.fn();
    const diag = createDiagnostics({
      path: join(tempDir(), "logs", "d.jsonl"),
      clock,
      warn,
      appendFile: (_p, data) => appended.push(data),
    });
    diag.event("x", { url: "https://a", text: "t", title: "t", prompt: "p", context: "c", tokenCount: 5, t: 9, epoch: 1 });
    expect(JSON.parse(appended[0]!)).toEqual({ t: 1234, event: "x", epoch: 1 });
    expect(warn).toHaveBeenCalledTimes(7);
  });

  it("never throws; counts write failures", () => {
    const diag = createDiagnostics({
      path: join(tempDir(), "d.jsonl"),
      clock,
      appendFile: () => {
        throw new Error("disk full");
      },
    });
    expect(() => diag.event("a")).not.toThrow();
    diag.event("b");
    expect(diag.failures).toBe(2);
  });

  it("uses SCOUT_HOME when set, else ~/.scout", () => {
    expect(scoutHome({ SCOUT_HOME: "/x" })).toBe("/x");
    expect(scoutHome({})).toMatch(/\.scout$/);
    expect(defaultDiagnosticsPath({ SCOUT_HOME: "/x" })).toBe("/x/logs/diagnostics.jsonl");
  });
});
