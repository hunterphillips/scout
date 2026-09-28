import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnostics, defaultDiagnosticsPath, MAX_STRING_FIELD, scoutHome } from "./diagnostics.js";

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
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

  it("drops keys containing a forbidden fragment but keeps contextRevision", () => {
    const appended: string[] = [];
    const diag = createDiagnostics({
      path: join(tempDir(), "d.jsonl"),
      clock,
      warn: () => {},
      appendFile: (_p, data) => appended.push(data),
    });
    diag.event("x", { pageUrl: "p", linkHref: "h", pageText: "t", contextRevision: 4, contextText: "c" });
    expect(JSON.parse(appended[0]!)).toEqual({ t: 1234, event: "x", contextRevision: 4 });
  });

  it("drops string values containing :// except origin, and truncates long strings", () => {
    const appended: string[] = [];
    const diag = createDiagnostics({
      path: join(tempDir(), "d.jsonl"),
      clock,
      warn: () => {},
      appendFile: (_p, data) => appended.push(data),
    });
    diag.event("x", { where: "https://docs.stripe.com/payments", origin: "https://docs.stripe.com", reason: "r".repeat(100) });
    expect(JSON.parse(appended[0]!)).toEqual({
      t: 1234,
      event: "x",
      origin: "https://docs.stripe.com",
      reason: "r".repeat(MAX_STRING_FIELD),
    });
  });

  it("recreates a log directory deleted after the first write", () => {
    const home = tempDir();
    const path = defaultDiagnosticsPath({ SCOUT_HOME: home });
    const diag = createDiagnostics({ path, clock });
    diag.event("a");
    rmSync(join(home, "logs"), { recursive: true });
    diag.event("b");
    diag.event("c");
    expect(diag.failures).toBe(1);
    expect(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).event)).toEqual(["c"]);
  });
});
