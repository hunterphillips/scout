// setup / uninstall / doctor with --agent-integration, against a temp home, a temp skills
// root and the shared fake `claude` (its user MCP registry is <temp home>/.claude.json).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runChecks } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { listTree, makeFakeClaude, makeFixture } from "./lib/test-fixture.mjs";
import { SKILL_TEMPLATE, sha256 } from "./lib/integration-skill.mjs";
import { readInstalledRecord } from "../packages/scout-core/dist/installedRecord.js";

const mode = (p) => statSync(p).mode & 0o777;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const sorted = (record) => ({ ...record, files: [...record.files].sort((a, b) => a.path.localeCompare(b.path)) });

function capture() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return { lines, out: push, err: push, text: () => lines.join("\n") };
}

let fx, fake, skillsRoot, env, L;
beforeEach(() => {
  fx = makeFixture({ spaces: false });
  fake = makeFakeClaude(join(fx.root, "fake-bin"));
  skillsRoot = join(fx.root, "claude-config", "skills");
  env = { ...fx.env, SCOUT_SKILLS_ROOT: skillsRoot, SCOUT_CLAUDE_BIN: fake.path };
  L = layout({ env, scoutRoot: fx.scoutRoot });
});
afterEach(() => fx.cleanup());

const registryFile = () => join(fx.home, ".claude.json");
const registry = () => (existsSync(registryFile()) ? json(registryFile()).mcpServers ?? {} : {});
const setRegistry = (servers) => writeFileSync(registryFile(), JSON.stringify({ mcpServers: servers }));
const ours = () => ({ type: "stdio", command: process.execPath, args: [L.mcpMain], env: {} });
const skillPath = () => join(skillsRoot, "scout-integration", "SKILL.md");
const template = () => readFileSync(SKILL_TEMPLATE, "utf8");

const setup = (args = [], e = env, extra = {}) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env: e, out: c.out, err: c.err, claudeFallbacks: [], ...extra });
  return { code, ...c };
};
const uninstall = async (args = ["--yes"], e = env, extra = {}) => {
  const c = capture();
  const code = await runUninstall(args, { env: e, out: c.out, err: c.err, claudeFallbacks: [], ...extra });
  return { code, ...c };
};
const doctor = (e = env, extra = {}) => runChecks(e, { claudeFallbacks: [], ...extra });
const integrationChecks = (results) => results.filter((r) => /agent integration|skillsRoot|integration skill|MCP/.test(r.label));

describe("setup without --agent-integration", () => {
  it("never runs claude mcp or touches the skills root, and says how to add the integration", () => {
    const r = setup();
    expect(r.code, r.text()).toBe(0);
    expect(fake.calls()).toEqual([]);
    expect(existsSync(skillsRoot)).toBe(false);
    expect(json(L.installed).skillsRoot).toBeUndefined();
    expect(r.text()).toMatch(/--agent-integration/);
    expect(doctor().find((x) => x.label === "agent integration")).toMatchObject({ status: "OK", detail: expect.stringMatching(/not installed/) });
  });
});

describe("setup --agent-integration --dry-run", () => {
  it("prints the plan and the scope explanation, and changes nothing", () => {
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    const r = setup(["--dry-run", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`mcp add --scope user scout -- ${process.execPath} ${L.mcpMain}`);
    expect(r.text()).toContain(skillPath());
    expect(r.text()).toMatch(/all of your Claude Code sessions/);
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(fake.calls().map((c) => c[1])).toEqual(["get"]);
  });
});

describe("setup --agent-integration", () => {
  it("registers through the CLI, copies the skill with private modes, and records skillsRoot and both entries", () => {
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(registry()).toEqual({ scout: ours() });
    expect(fake.calls()).toContainEqual(["mcp", "add", "--scope", "user", "scout", "--", process.execPath, L.mcpMain]);
    expect(readFileSync(skillPath(), "utf8")).toBe(template());
    expect(mode(skillPath())).toBe(0o600);
    expect(mode(join(skillsRoot, "scout-integration"))).toBe(0o700);
    expect(mode(skillsRoot)).toBe(0o700);

    const record = json(L.installed);
    expect(record.version).toBe(1);
    expect(record.skillsRoot).toBe(skillsRoot);
    expect(record.files.filter((f) => ["skill", "mcp-registration"].includes(f.kind))).toEqual([
      { path: skillPath(), kind: "skill", sha256: sha256(template()) },
      { path: `${process.execPath} ${L.mcpMain}`, kind: "mcp-registration", name: "scout", scope: "user" },
    ]);
    expect(record.files).toHaveLength(8);
    // The core's reader accepts what setup wrote.
    expect(readInstalledRecord(L.scoutHome)).toEqual({ skillsRoot });
    expect(r.text()).toMatch(/all of your Claude Code sessions/);
    expect(r.text()).toMatch(/Browser context .* separate opt-in/);

    const checks = integrationChecks(doctor());
    expect(checks.length).toBe(3);
    expect(checks.filter((x) => x.status !== "OK")).toEqual([]);
  });

  it("is idempotent: a re-run keeps both without a second add", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const first = json(L.installed);
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(fake.calls().filter((c) => c[1] === "add")).toHaveLength(1);
    expect(sorted(json(L.installed))).toEqual(sorted(first));
    // A plain re-run leaves the integration recorded and in place.
    expect(setup().code).toBe(0);
    expect(sorted(json(L.installed))).toEqual(sorted(first));
    expect(registry()).toEqual({ scout: ours() });
  });

  it("replaces this install's earlier registration (recorded command) instead of refusing it", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const old = { type: "stdio", command: "/old/node", args: [L.mcpMain], env: {} };
    setRegistry({ scout: old });
    const rec = json(L.installed);
    rec.files = rec.files.map((f) => (f.kind === "mcp-registration" ? { ...f, path: `/old/node ${L.mcpMain}` } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(registry()).toEqual({ scout: ours() });
    expect(json(L.installed).files.filter((f) => f.kind === "mcp-registration")).toHaveLength(1);
  });

  it("refuses a foreign `scout` registration and writes nothing", () => {
    const foreign = { scout: { type: "stdio", command: "/usr/local/bin/someone-else", args: [], env: {} } };
    setRegistry(foreign);
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    for (const args of [["--agent-integration"], ["--agent-integration", "--dry-run"]]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/already registered/);
    }
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(registry()).toEqual(foreign);
    expect(fake.calls().some((c) => c[1] !== "get")).toBe(false);
  });

  it("refuses when `claude mcp get` cannot tell (killed), writing nothing", () => {
    setRegistry({ scout: { type: "stdio", command: "/x", args: [], env: {} } });
    fake.setMode("mcp-get-killed");
    const r = setup(["--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/could not tell/);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses a conflicting scout-integration dir and writes nothing", () => {
    mkdirSync(join(skillsRoot, "scout-integration"), { recursive: true });
    writeFileSync(skillPath(), "someone else's skill");
    const r = setup(["--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/not this install's skill/);
    expect(readFileSync(skillPath(), "utf8")).toBe("someone else's skill");
    expect(existsSync(L.installed)).toBe(false);
    expect(registry()).toEqual({});
  });

  it("refuses a symlinked skills root or a symlinked ancestor", () => {
    const real = join(fx.root, "real-skills");
    mkdirSync(real);
    mkdirSync(join(fx.root, "claude-config"));
    symlinkSync(real, skillsRoot);
    let r = setup(["--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/symlink/);
    expect(listTree(real)).toEqual([]);

    const linkedParent = join(fx.root, "linked-config");
    symlinkSync(join(fx.root, "claude-config"), linkedParent);
    r = setup(["--agent-integration"], { ...env, SCOUT_SKILLS_ROOT: join(linkedParent, "skills2") });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/symlink/);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses paths with spaces (claude mcp get joins args by spaces)", () => {
    fx.cleanup();
    fx = makeFixture({ spaces: true });
    fake = makeFakeClaude(join(fx.root, "fake-bin"));
    const e = { ...fx.env, SCOUT_SKILLS_ROOT: join(fx.root, "skills"), SCOUT_CLAUDE_BIN: fake.path };
    const r = setup(["--agent-integration"], e);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/no spaces/);
    expect(fake.calls()).toEqual([]);
  });

  it("a test install needs both SCOUT_SKILLS_ROOT and SCOUT_CLAUDE_BIN, so it cannot reach the real Claude config", () => {
    for (const drop of ["SCOUT_SKILLS_ROOT", "SCOUT_CLAUDE_BIN"]) {
      const r = setup(["--agent-integration"], { ...env, [drop]: undefined });
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/needs both SCOUT_SKILLS_ROOT and SCOUT_CLAUDE_BIN/);
    }
    expect(existsSync(L.installed)).toBe(false);
    expect(fake.calls()).toEqual([]);
  });

  it("each override moves only its own location", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    expect(existsSync(L.nmhManifest)).toBe(true);
    expect(L.nmhManifest.startsWith(fx.env.CHROME_NMH_DIR)).toBe(true);
    expect(listTree(skillsRoot)).toEqual(["scout-integration/SKILL.md"]);
    expect(existsSync(join(fx.home, ".claude", "skills"))).toBe(false);
    expect(json(L.scoutConfig).scoutRoot).toBe(fx.scoutRoot);
  });
});

describe("uninstall and the agent integration", () => {
  const wrapperName = "scout-llms-0123456789abcdef";
  const installWithNeighbours = () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    setRegistry({ ...registry(), other: { type: "stdio", command: "/bin/other", args: [], env: {} } });
    mkdirSync(join(skillsRoot, "someone-skill"));
    writeFileSync(join(skillsRoot, "someone-skill", "SKILL.md"), "x");
    mkdirSync(join(skillsRoot, wrapperName));
    writeFileSync(join(skillsRoot, wrapperName, "SKILL.md"), "runtime wrapper");
    mkdirSync(join(L.scoutHome, "capabilities"), { recursive: true });
    writeFileSync(L.exportsManifest, JSON.stringify({ schemaVersion: 1, skillsRoot, entries: [{ name: wrapperName }], conflicts: [] }));
  };

  it("--agent-integration removes only ours, drops skillsRoot and both entries, keeps everything else", async () => {
    installWithNeighbours();
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(Object.keys(registry())).toEqual(["other"]);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
    expect(existsSync(join(skillsRoot, "someone-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, wrapperName, "SKILL.md"))).toBe(true);
    expect(r.text()).toMatch(/wrappers remaining in .*: 1/);
    const record = json(L.installed);
    expect(record.skillsRoot).toBeUndefined();
    expect(record.files.map((f) => f.kind).sort()).toEqual(["config", "config-merged", "extension-manifest-key", "key", "nmh-manifest", "wrapper"]);
    expect(existsSync(L.wrapper)).toBe(true);
    expect(readInstalledRecord(L.scoutHome)).toEqual({});
  });

  it("--dry-run changes nothing", async () => {
    installWithNeighbours();
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    const reg = registry();
    const r = await uninstall(["--dry-run", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toMatch(/would remove MCP server "scout"/);
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(registry()).toEqual(reg);
  });

  it("the full uninstall removes the integration too and then the record", async () => {
    installWithNeighbours();
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(0);
    expect(Object.keys(registry())).toEqual(["other"]);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
    expect(existsSync(join(skillsRoot, wrapperName))).toBe(true);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("leaves a modified skill and reports it; the registration still goes", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    writeFileSync(skillPath(), template() + "\nedited\n");
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(2);
    expect(r.text()).toMatch(/SKIP .*scout-integration \(changed since setup/);
    expect(readFileSync(skillPath(), "utf8")).toMatch(/edited/);
    expect(registry()).toEqual({});
    const record = json(L.installed);
    expect(record.skillsRoot).toBe(skillsRoot);
    expect(record.files.filter((f) => f.kind === "skill")).toHaveLength(1);
    expect(record.files.filter((f) => f.kind === "mcp-registration")).toHaveLength(0);
  });

  it("leaves a registration that changed since setup", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const changed = { scout: { ...ours(), args: [L.mcpMain, "--socket", "/elsewhere"] } };
    setRegistry(changed);
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(2);
    expect(r.text()).toMatch(/SKIP MCP server "scout" \(registration changed/);
    expect(registry()).toEqual(changed);
    expect(fake.calls().some((c) => c[1] === "remove")).toBe(false);
    expect(json(L.installed).files.filter((f) => f.kind === "mcp-registration")).toHaveLength(1);
  });

  it.each([
    ["killed", "mcp-get-killed", {}],
    ["timed out", "mcp-get-hang", { mcpTimeoutMs: 500 }],
  ])("leaves the registration alone when `get` %s", async (_label, m, extra) => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    fake.setMode(m);
    const r = await uninstall(["--yes", "--agent-integration"], env, extra);
    expect(r.code).toBe(2);
    expect(r.text()).toMatch(/could not tell/);
    expect(registry()).toEqual({ scout: ours() });
    expect(fake.calls().some((c) => c[1] === "remove")).toBe(false);
    expect(json(L.installed).files.filter((f) => f.kind === "mcp-registration")).toHaveLength(1);
  });

  it("ignores a tampered registration or skill entry", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const rec = json(L.installed);
    const victim = join(fx.root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "SKILL.md"), "victim");
    rec.files = rec.files.map((f) =>
      f.kind === "mcp-registration" ? { ...f, path: "/bin/sh -c" } : f.kind === "skill" ? { ...f, path: join(victim, "SKILL.md") } : f,
    );
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(2);
    expect(readFileSync(join(victim, "SKILL.md"), "utf8")).toBe("victim");
    expect(registry()).toEqual({ scout: ours() });
  });

  it("says so when no integration is recorded", async () => {
    expect(setup().code).toBe(0);
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(0);
    expect(r.text()).toMatch(/no agent integration/);
    expect(fake.calls()).toEqual([]);
  });
});

describe("doctor and the agent integration", () => {
  const status = (label) => integrationChecks(doctor()).find((r) => r.label.includes(label));

  it("reports the skill as ours, modified or absent", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    writeFileSync(skillPath(), "edited");
    expect(status("integration skill")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/modified$/) });
    writeFileSync(skillPath(), template());
    chmodSync(skillPath(), 0o600);
    expect(status("integration skill").status).toBe("OK");
    rmSync(join(skillsRoot, "scout-integration"), { recursive: true });
    expect(status("integration skill")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/absent$/) });
  });

  it("reports the registration as ours, absent, foreign or unknown", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    expect(status('MCP server "scout"').status).toBe("OK");
    setRegistry({});
    expect(status('MCP server "scout"')).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/absent/) });
    setRegistry({ scout: { type: "stdio", command: "/bin/other", args: [], env: {} } });
    expect(status('MCP server "scout"')).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/foreign/) });
    fake.setMode("mcp-get-killed");
    expect(status('MCP server "scout"').status).toBe("WARN");
    const noBin = integrationChecks(doctor({ ...env, SCOUT_CLAUDE_BIN: undefined })).find((r) => r.label.includes("MCP registration"));
    expect(noBin.status).toBe("WARN");
  });

  it("fails when the recorded skillsRoot is not a real directory", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const rec = json(L.installed);
    writeFileSync(L.installed, JSON.stringify({ ...rec, skillsRoot: join(fx.root, "missing") }));
    expect(status("skillsRoot").status).toBe("FAIL");
  });
});
