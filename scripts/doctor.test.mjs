// doctor's eight sections against a temp home. Nothing here starts Scout, Chrome, or a
// real claude; the fake claude logs its argv so the tests can see doctor only asks --version.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { SECTIONS, runDoctor, runReport } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { makeFixture } from "./lib/test-fixture.mjs";
import { lastPreflight } from "./lib/core-state.mjs";

let fx, L, env, argvLog;
beforeEach(() => {
  fx = makeFixture({ spaces: false });
  argvLog = join(fx.root, "claude-argv.log");
  writeFileSync(join(fx.binDir, "claude"), `#!/bin/sh\necho "$@" >> '${argvLog}'\necho "2.1.286 (Claude Code)"\n`);
  env = fx.env;
  L = layout({ env, scoutRoot: fx.scoutRoot });
  expect(runSetup(["--scout-root", fx.scoutRoot], { env, out: () => {}, err: () => {}, claudeFallbacks: [] })).toBe(0);
});
afterEach(() => fx.cleanup());

const report = (e = env, extra = {}) => Object.fromEntries(runReport(e, { claudeFallbacks: [], ...extra }).map((s) => [s.title, s]));
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("doctor report", () => {
  it("has the eight sections in order, each ok|warn|fail with one line, and exits 0 on warnings alone", () => {
    const sections = runReport(env, { claudeFallbacks: [] });
    expect(sections.map((s) => s.title)).toEqual(SECTIONS);
    for (const s of sections) {
      expect(["ok", "warn", "fail"]).toContain(s.status);
      expect(s.summary).not.toMatch(/\n/);
      expect(s.summary.length).toBeGreaterThan(0);
    }
    const lines = [];
    expect(runDoctor(env, (l) => lines.push(l), { claudeFallbacks: [] })).toBe(0);
    for (const t of SECTIONS) expect(lines.some((l) => new RegExp(`^(ok|warn|fail) +${t}: `).test(l))).toBe(true);
    expect(lines.at(-1)).toBe("No failed checks.");
  });

  it("install record: fails without one", () => {
    rmSync(L.installed);
    const r = report();
    expect(r["install record"]).toMatchObject({ status: "fail", summary: expect.stringMatching(/missing; run `npm run setup`/) });
  });

  it("Chrome relay: a test home without CHROME_NMH_DIR fails the override rule", () => {
    const r = report({ ...env, CHROME_NMH_DIR: undefined })["Chrome relay"];
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.label === "CHROME_NMH_DIR test-override rule")).toMatchObject({ status: "FAIL" });
  });

  it("core: not running warns; a live lock with private sockets and token is ok; a loose socket fails", async () => {
    expect(report().core).toMatchObject({ status: "warn", summary: expect.stringMatching(/^not running/) });

    // A short SCOUT_HOME: a Unix socket path must fit in 104 bytes.
    const short = mkdtempSync(join(realpathSync("/tmp"), "sd-"));
    const servers = [];
    try {
      const e = { ...env, SCOUT_HOME: short };
      const S = layout({ env: e, scoutRoot: fx.scoutRoot });
      mkdirSync(S.runDir, { recursive: true, mode: 0o700 });
      mkdirSync(join(short, "capabilities"), { mode: 0o700 });
      writeFileSync(S.storeLock, JSON.stringify({ pid: process.pid, instanceId: "i", startedAt: 1 }));
      for (const p of [S.coreSock, S.agentSock]) {
        const srv = createServer();
        await new Promise((res) => srv.listen(p, res));
        chmodSync(p, 0o600);
        servers.push(srv);
      }
      writeFileSync(S.agentToken, "t", { mode: 0o600 });
      const ok = report(e).core;
      expect(ok).toMatchObject({ status: "ok", summary: `running (pid ${process.pid})` });

      chmodSync(S.agentSock, 0o666);
      const bad = report(e).core;
      expect(bad.status).toBe("fail");
      expect(bad.checks.find((c) => c.status === "FAIL").label).toBe("run/agent.sock is a 0600 socket owned by you");

      // A gone pid: stale lock and leftover sockets warn, never fail.
      writeFileSync(S.storeLock, JSON.stringify({ pid: 2 ** 22 + 12345, instanceId: "i", startedAt: 1 }));
      chmodSync(S.agentSock, 0o600);
      expect(report(e).core).toMatchObject({ status: "warn", summary: expect.stringMatching(/not running \(stale lock from pid/) });
    } finally {
      for (const s of servers) await new Promise((res) => s.close(res));
      rmSync(short, { recursive: true, force: true });
    }
  });

  it("Chrome relay: names the host's bridge protocol from the built contracts and fails wrong allowed_origins", () => {
    const ok = report()["Chrome relay"];
    expect(ok.status).toBe("ok");
    expect(ok.summary).toMatch(/^host dev\.scout\.bridge allows chrome-extension:\/\/[a-p]{32}\/; bridge protocol 3$/);
    writeFileSync(L.nmhManifest, JSON.stringify({ ...json(L.nmhManifest), allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }));
    chmodSync(L.nmhManifest, 0o644);
    const bad = report()["Chrome relay"];
    expect(bad.status).toBe("fail");
    expect(bad.summary).toMatch(/^host manifest not usable/);
  });

  it("agent integration: not installed is ok and optional", () => {
    expect(report()["agent integration"]).toMatchObject({ status: "ok", summary: "not installed (optional)" });
  });

  it("CLI: the version check is advisory and is the only thing doctor asks claude", () => {
    expect(report().CLI).toMatchObject({ status: "ok", summary: `${join(fx.binDir, "claude")} 2.1.286 (verified 2.1.286)` });
    const newer = report(env, { claudeVersion: () => "2.1.300" }).CLI;
    expect(newer.status).toBe("warn");
    expect(newer.checks.find((c) => c.status === "WARN").detail).toMatch(/verified with 2\.1\.286\. Jobs still run/);
    const lines = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(new Set(lines)).toEqual(new Set(["--version"]));
  });

  it("CLI: a profile for another adapter gets no claude checks", () => {
    writeFileSync(L.agentProfile, JSON.stringify({ schemaVersion: 1, adapter: "other-agent" }), { mode: 0o600 });
    const cli = report().CLI;
    expect(cli).toMatchObject({ status: "warn", summary: "adapter other-agent" });
    expect(cli.checks.some((c) => /claude/.test(c.label))).toBe(false);
  });

  it("agent: reports the core's last logged verdict, else not yet checked, and never runs a preflight", () => {
    expect(report().agent).toMatchObject({ status: "warn", summary: "not yet checked" });
    mkdirSync(L.logsDir, { recursive: true });
    const log = [
      { t: 1, event: "agent_preflight", verdict: "unavailable", reasons: 1 },
      { t: 2, event: "visit_change" },
      { t: 1_800_000_000_000, event: "agent_preflight", verdict: "ready", reasons: 0, cliVersion: "2.1.286" },
    ];
    writeFileSync(L.diagnosticsLog, log.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
    expect(report().agent).toMatchObject({ status: "ok", summary: "last preflight: ready (CLI 2.1.286)" });
    writeFileSync(L.diagnosticsLog, JSON.stringify({ t: 3, event: "agent_preflight", verdict: "api_key", reasons: 1 }) + "\n");
    expect(report().agent.status).toBe("warn");
    expect(readFileSync(argvLog, "utf8")).not.toMatch(/auth|-p|--print/);
  });

  it("agent ignores a preflight event without a finite time, and a log that is not a regular file", () => {
    mkdirSync(L.logsDir, { recursive: true });
    writeFileSync(L.diagnosticsLog, JSON.stringify({ event: "agent_preflight", verdict: "ready" }) + "\n");
    expect(report().agent).toMatchObject({ status: "warn", summary: "not yet checked" });
    rmSync(L.diagnosticsLog);
    mkdirSync(L.diagnosticsLog);
    expect(lastPreflight(L.diagnosticsLog)).toBeNull();
  });

  it("agent reads only the log's tail", () => {
    mkdirSync(L.logsDir, { recursive: true });
    const early = JSON.stringify({ t: 1, event: "agent_preflight", verdict: "ready", reasons: 0 }) + "\n";
    writeFileSync(L.diagnosticsLog, early + `${JSON.stringify({ t: 2, event: "visit_change" })}\n`.repeat(100));
    expect(lastPreflight(L.diagnosticsLog)).toMatchObject({ verdict: "ready" });
    expect(lastPreflight(L.diagnosticsLog, { maxBytes: 1024 })).toBeNull();
  });

  it("suggestions: empty destinations is off; listed hosts are on", () => {
    expect(report().suggestions).toMatchObject({ status: "ok", summary: "off (no destinations in config.json)" });
    writeFileSync(L.scoutConfig, JSON.stringify({ ...json(L.scoutConfig), destinations: ["docs.stripe.com"] }));
    expect(report().suggestions.summary).toBe("on for docs.stripe.com");
  });

  it("exits 1 when any section fails", () => {
    chmodSync(L.wrapper, 0o755);
    const lines = [];
    expect(runDoctor(env, (l) => lines.push(l), { claudeFallbacks: [] })).toBe(1);
    expect(lines).toContain("fail Chrome relay: host dev.scout.bridge allows " + `chrome-extension://${json(L.scoutConfig).extensionId}/; bridge protocol 3`);
    expect(lines.some((l) => /^ +FAIL wrapper mode is 0700/.test(l))).toBe(true);
  });
});
