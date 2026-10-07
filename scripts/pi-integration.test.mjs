import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runReport } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { makeFixture, makeFakePi } from "./lib/test-fixture.mjs";

let fx, fake, env, L, agentDir;
const messages = () => { const out = [], err = []; return { out: (x) => out.push(x), err: (x) => err.push(x), lines: () => [...out, ...err].join("\n") }; };
const setup = (args = []) => { const m = messages(); return { code: runSetup(["--scout-root", fx.scoutRoot, "--agent", "pi", ...args], { env, out: m.out, err: m.err }), lines: m.lines() }; };
const registry = () => JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
beforeEach(() => {
  fx = makeFixture({ withClaude: false, spaces: false });
  fake = makeFakePi(fx.binDir);
  agentDir = join(fx.home, "pi-agent");
  mkdirSync(agentDir);
  env = { ...fx.env, SCOUT_PI_BIN: fake.path, SCOUT_PI_AGENT_DIR: agentDir };
  L = layout({ env, scoutRoot: fx.scoutRoot });
});
afterEach(() => fx.cleanup());

describe("Pi setup and integration", () => {
  it("writes the Pi profile from built constants", () => {
    expect(setup().code).toBe(0);
    expect(JSON.parse(readFileSync(L.agentProfile, "utf8"))).toEqual({ schemaVersion: 1, adapter: "pi", piPath: fake.path, thinking: "low" });
  });
  it("chooses Pi when it is the only test-home agent", () => {
    const m = messages();
    expect(runSetup(["--scout-root", fx.scoutRoot], { env, out: m.out, err: m.err })).toBe(0);
    expect(JSON.parse(readFileSync(L.agentProfile, "utf8")).adapter).toBe("pi");
  });
  it("doctor warns for Pi version drift, old node, and unavailable preflight", () => {
    expect(setup().code).toBe(0);
    let cli = runReport(env, { piVersion: () => "1.0.5" }).find((s) => s.title === "CLI");
    expect(cli.checks.find((c) => /pi version matches/.test(c.label)).status).toBe("WARN");
    const oldNode = join(fx.binDir, "old-node");
    writeFileSync(oldNode, "#!/bin/sh\necho v22.18.0\n", { mode: 0o755 });
    const config = JSON.parse(readFileSync(L.scoutConfig, "utf8"));
    writeFileSync(L.scoutConfig, JSON.stringify({ ...config, nodePath: oldNode }));
    cli = runReport(env).find((s) => s.title === "CLI");
    expect(cli.checks.find((c) => c.label === "core node version for Pi").status).toBe("WARN");
    mkdirSync(L.logsDir, { recursive: true });
    writeFileSync(L.diagnosticsLog, JSON.stringify({ t: 1800000000000, event: "agent_preflight", adapter: "pi", verdict: "unavailable", reasons: 1 }) + "\n");
    expect(runReport(env).find((s) => s.title === "agent").status).toBe("warn");
    writeFileSync(L.diagnosticsLog, JSON.stringify({ t: 1800000000001, event: "agent_preflight", adapter: "codex", verdict: "ready", reasons: 0 }) + "\n", { flag: "a" });
    expect(runReport(env).find((s) => s.title === "agent").summary).toContain("unavailable");
    expect(fake.calls().every((a) => a.join(" ") === "--version")).toBe(true);
  });
  it("doctor fails for a missing Pi executable", () => {
    expect(setup().code).toBe(0);
    const profile = JSON.parse(readFileSync(L.agentProfile, "utf8"));
    writeFileSync(L.agentProfile, JSON.stringify({ ...profile, piPath: join(fx.root, "missing-pi") }));
    const cli = runReport(env).find((section) => section.title === "CLI");
    expect(cli.checks.find((check) => check.label === "agent profile names an executable pi").status).toBe("FAIL");
  });
  it("requires test overrides and refuses foreign registrations before writes", () => {
    expect(runSetup(["--scout-root", fx.scoutRoot, "--agent", "pi", "--agent-integration"], { env: { ...env, SCOUT_PI_AGENT_DIR: undefined }, out: () => {}, err: () => {} })).toBe(1);
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { scout: { command: "/foreign", args: [], exposure: "direct" } } }));
    const rejected = setup(["--agent-integration"]);
    expect(rejected.code).toBe(1);
    expect(rejected.lines).not.toContain("/foreign");
    expect(registry().mcpServers.scout.command).toBe("/foreign");
  });
  it("refuses changed registration on uninstall and leaves it in place", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const data = registry();
    data.mcpServers.scout.exposure = "other";
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(data));
    const m = messages();
    expect(await runUninstall(["--agent-integration", "--yes"], { env, out: m.out, err: m.err })).toBe(2);
    expect(registry().mcpServers.scout.exposure).toBe("other");
    expect(fake.calls().some((a) => a[0] === "mcp" && a[1] === "remove")).toBe(false);
  });
  it("refuses a symlinked mcp.json before adding", () => {
    const target = join(fx.root, "registry.json");
    writeFileSync(target, JSON.stringify({ mcpServers: {} }));
    symlinkSync(target, join(agentDir, "mcp.json"));
    expect(setup(["--agent-integration"]).code).toBe(1);
    expect(fake.calls()).toEqual([]);
  });
  it("adds, keeps, diagnoses and uninstalls its registration and skill", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const entry = registry().mcpServers.scout;
    expect(entry).toEqual({ command: process.execPath, args: [L.mcpMain], exposure: "direct" });
    const skill = readFileSync(join(agentDir, "skills", "scout-integration", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: scout-integration\ndescription:/);
    expect(fake.entries().find((entry) => entry.argv?.[1] === "add")?.skills).toContain("scout-integration");
    expect(setup(["--agent-integration"]).code).toBe(0);
    expect(fake.calls().filter((a) => a[0] === "mcp" && a[1] === "add")).toHaveLength(1);
    const report = runReport(env);
    expect(report.find((s) => s.title === "agent integration").status).toBe("ok");
    expect(report.find((s) => s.title === "CLI").summary).toContain("1.0.4");
    const m = messages();
    expect(await runUninstall(["--agent-integration", "--yes"], { env, out: m.out, err: m.err })).toBe(0);
    expect(registry().mcpServers.scout).toBeUndefined();
  });
});
