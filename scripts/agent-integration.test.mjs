// setup / uninstall / doctor with --agent-integration, against a temp home, a temp skills
// root and the shared fake `claude` (its user MCP registry is <temp home>/.claude.json).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runChecks } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { exportRealWrappers, listTree, makeFakeClaude, makeFixture } from "./lib/test-fixture.mjs";
import { SKILL_TEMPLATE, sha256 } from "./lib/integration-skill.mjs";
import { readInstalled } from "./lib/installed.mjs";
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
const GET_NOTE = "`claude mcp get scout` runs read-only; the Claude CLI health-checks (starts) whatever is registered under that name";
const writeExports = (root, names) => {
  mkdirSync(join(L.scoutHome, "capabilities"), { recursive: true });
  writeFileSync(L.exportsManifest, JSON.stringify({ schemaVersion: 1, skillsRoot: root, entries: names.map((name) => ({ name })), conflicts: [] }));
};

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
    expect(r.text()).toContain(GET_NOTE);
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
    expect(r.text()).toMatch(/Browser context .* separate opt-in, off by default: turn it on in Scout's settings \(it is `agentBrowserContext` in ~\/\.scout\/config\.json\)/);
    expect(r.text()).toMatch(/Start a new Claude Code session/);
    expect(r.text()).not.toMatch(/P2\.\d/);
    expect(template()).not.toMatch(/P2\.\d/);
    expect(template()).toMatch(/`agentBrowserContext` in ~\/\.scout\/config\.json/);

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
      expect(r.text()).toMatch(/scope: User config.*command differs from this install's \(sha256 [0-9a-f]{12}\)/);
      expect(r.text()).not.toContain("someone-else");
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

  it("records skillsRootCreated only when setup created the skills root", async () => {
    let r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`created skills root ${skillsRoot}`);
    expect(json(L.installed).skillsRootCreated).toBe(true);
    expect(readInstalledRecord(L.scoutHome)).toEqual({ skillsRoot });
    // A re-run keeps the flag.
    expect(setup(["--agent-integration"]).code).toBe(0);
    expect(json(L.installed).skillsRootCreated).toBe(true);
    r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`left skills root ${skillsRoot} in place: setup created it, but Claude Code shares it`);
    expect(existsSync(skillsRoot)).toBe(true);
    expect("skillsRootCreated" in json(L.installed)).toBe(false);
    expect("skillsRoot" in json(L.installed)).toBe(false);
  });

  it("does not record skillsRootCreated when the skills root already existed", async () => {
    mkdirSync(skillsRoot, { recursive: true });
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).not.toMatch(/created skills root/);
    expect("skillsRootCreated" in json(L.installed)).toBe(false);
    const u = await uninstall(["--yes", "--agent-integration"]);
    expect(u.code, u.text()).toBe(0);
    expect(u.text()).not.toMatch(/setup created it/);
  });

  it("readInstalled rejects a non-boolean skillsRootCreated", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    writeFileSync(L.installed, JSON.stringify({ ...json(L.installed), skillsRootCreated: "yes" }));
    expect(() => readInstalled(L.installed)).toThrow(/skillsRootCreated/);
  });

  it("upgrades an installed skill with an older recorded hash in place", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const old = "---\nname: scout-integration\ndescription: an older template\n---\n";
    writeFileSync(skillPath(), old);
    const rec = json(L.installed);
    rec.files = rec.files.map((f) => (f.kind === "skill" ? { ...f, sha256: sha256(old) } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`wrote ${skillPath()} (0600)`);
    expect(readFileSync(skillPath(), "utf8")).toBe(template());
    expect(json(L.installed).files.find((f) => f.kind === "skill").sha256).toBe(sha256(template()));
  });

  it("reports the kept skill's actual mode", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    let r = setup(["--agent-integration"]);
    expect(r.text()).toContain(`kept  ${skillPath()} (0600)`);
    chmodSync(skillPath(), 0o644);
    r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`kept  ${skillPath()} (0644)`);
  });

  it("refuses SCOUT_SKILLS_ROOT or SCOUT_CLAUDE_BIN on the real ~/.scout", () => {
    for (const e of [env, { ...env, SCOUT_CLAUDE_BIN: undefined }, { ...env, SCOUT_SKILLS_ROOT: undefined }]) {
      for (const args of [["--agent-integration"], ["--agent-integration", "--dry-run"]]) {
        const r = setup(args, e, { realHome: fx.home });
        expect(r.code).toBe(1);
        expect(r.text()).toMatch(/for test installs only and refused with the real ~\/\.scout/);
      }
    }
    expect(fake.calls()).toEqual([]);
    expect(existsSync(L.installed)).toBe(false);
    expect(existsSync(skillsRoot)).toBe(false);
  });

  it("refuses a different skills root while the Scout app has wrappers exported under another", () => {
    const other = join(fx.root, "other-skills");
    writeExports(other, ["scout-llms-0123456789abcdef"]);
    for (const args of [["--agent-integration"], ["--agent-integration", "--dry-run"]]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toContain(`has 1 skill wrapper(s) exported under ${other}, not ${skillsRoot}`);
    }
    expect(existsSync(L.installed)).toBe(false);
    expect(fake.calls()).toEqual([]);
    // No wrappers listed: the other root does not matter.
    writeExports(other, []);
    expect(setup(["--agent-integration"]).code).toBe(0);
  });

  it("a failed `claude mcp add` that still wrote the entry fails setup, stays recorded, and uninstall removes it", async () => {
    fake.setMode("mcp-add-fail");
    const r = setup(["--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/claude mcp add` failed/);
    expect(registry()).toEqual({ scout: ours() });
    expect(json(L.installed).files.filter((f) => f.kind === "mcp-registration")).toEqual([
      { path: `${process.execPath} ${L.mcpMain}`, kind: "mcp-registration", name: "scout", scope: "user" },
    ]);
    fake.setMode("");
    const u = await uninstall(["--yes", "--agent-integration"]);
    expect(u.code, u.text()).toBe(0);
    expect(registry()).toEqual({});
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
  const foreignName = "scout-llms-0123456789abcdef";
  /** The integration, a neighbour skill, a foreign `scout-*` dir, and two wrappers the Scout app exported. */
  const installWithNeighbours = async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    setRegistry({ ...registry(), other: { type: "stdio", command: "/bin/other", args: [], env: {} } });
    mkdirSync(join(skillsRoot, "someone-skill"));
    writeFileSync(join(skillsRoot, "someone-skill", "SKILL.md"), "x");
    mkdirSync(join(skillsRoot, foreignName));
    writeFileSync(join(skillsRoot, foreignName, "SKILL.md"), "not Scout's: the manifest does not list it");
    return exportRealWrappers(L.scoutHome, skillsRoot, ["pay", "refund"]);
  };
  const exportsEntries = () => json(L.exportsManifest).entries.map((e) => e.name);

  it("--agent-integration removes the app's unchanged wrappers first, then only ours; drops skillsRoot and both entries", async () => {
    const wrappers = await installWithNeighbours();
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    for (const w of wrappers) {
      expect(existsSync(join(skillsRoot, w))).toBe(false);
      expect(r.text()).toContain(`removed ${join(skillsRoot, w)} (Scout app skill wrapper, unchanged since Scout wrote it)`);
    }
    expect(exportsEntries()).toEqual([]);
    expect(Object.keys(registry())).toEqual(["other"]);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
    expect(existsSync(join(skillsRoot, "someone-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, foreignName, "SKILL.md"))).toBe(true);
    const record = json(L.installed);
    expect(record.skillsRoot).toBeUndefined();
    expect(record.files.map((f) => f.kind).sort()).toEqual(["agent-profile", "config", "extension-manifest-key", "key", "nmh-manifest", "wrapper"]);
    expect(existsSync(L.wrapper)).toBe(true);
    expect(readInstalledRecord(L.scoutHome)).toEqual({});
  });

  it("keeps and lists a wrapper changed since Scout wrote it, removes the rest, and exits 2", async () => {
    const [changed, exact] = await installWithNeighbours();
    writeFileSync(join(skillsRoot, changed, "SKILL.md"), "my own edit");
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code, r.text()).toBe(2);
    expect(readFileSync(join(skillsRoot, changed, "SKILL.md"), "utf8")).toBe("my own edit");
    expect(existsSync(join(skillsRoot, exact))).toBe(false);
    expect(r.text()).toContain(`SKIP ${join(skillsRoot, changed)} (Scout app skill wrapper, changed since Scout wrote it; not touching`);
    expect(r.text()).toMatch(/Scout app skill wrappers left in .*: 1 .*delete them yourself/);
    expect(exportsEntries()).toEqual([changed]);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
  });

  it("stops before changing anything while Scout runs (it holds the store lock): quit Scout first", async () => {
    const wrappers = await installWithNeighbours();
    // A live pid in the lock: this test process stands in for the running core.
    writeFileSync(join(L.scoutHome, "capabilities", "store.lock"), JSON.stringify({ pid: process.pid, instanceId: "core", startedAt: 1 }));
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    const reg = registry();
    for (const args of [["--yes", "--agent-integration"], ["--yes"]]) {
      const r = await uninstall(args);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/Scout is running \(pid \d+\) and owns its skill wrappers; quit Scout first\. Nothing changed\./);
    }
    const dry = await uninstall(["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.text()).toMatch(/Scout is running \(pid \d+\): the real run would stop here/);
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(registry()).toEqual(reg);
    for (const w of wrappers) expect(existsSync(join(skillsRoot, w))).toBe(true);
  });

  it("stops when exports.json cannot be trusted, changing nothing", async () => {
    await installWithNeighbours();
    writeFileSync(L.exportsManifest, JSON.stringify({ schemaVersion: 1, skillsRoot, entries: [{ name: foreignName }], conflicts: [] }));
    // The core CLI logs the refusal to diagnostics; nothing else may change.
    const tree = () => listTree(fx.root).filter((f) => !f.startsWith("fake-bin/") && !f.endsWith("logs/diagnostics.jsonl"));
    const before = tree();
    const r = await uninstall(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/could not remove the Scout app's skill wrappers \(unexport-all: skill export: manifest_(schema|not_private).*\)\. Nothing changed\./);
    expect(tree()).toEqual(before);
  });

  it("--dry-run shows the unexport step and changes nothing", async () => {
    await installWithNeighbours();
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    const reg = registry();
    const r = await uninstall(["--dry-run", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toMatch(/would run .*cli\.js capabilities unexport-all --home /);
    expect(r.text()).toMatch(/remove each of the 2 Scout app skill wrapper\(s\) listed in .*exports\.json that is unchanged/);
    expect(r.text()).toMatch(/would remove MCP server "scout"/);
    expect(r.text()).toContain(GET_NOTE);
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(registry()).toEqual(reg);
  });

  it("the full uninstall removes the wrappers, the integration, and then the record", async () => {
    const wrappers = await installWithNeighbours();
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(0);
    expect(Object.keys(registry())).toEqual(["other"]);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
    for (const w of wrappers) expect(existsSync(join(skillsRoot, w))).toBe(false);
    expect(existsSync(join(skillsRoot, foreignName))).toBe(true);
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

  it("leaves the skill when the skills root became a symlink", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const moved = join(fx.root, "moved-skills");
    renameSync(skillsRoot, moved);
    symlinkSync(moved, skillsRoot);
    for (const args of [["--dry-run", "--agent-integration"], ["--yes", "--agent-integration"]]) {
      const r = await uninstall(args);
      expect(r.code).toBe(2);
      expect(r.text()).toMatch(/SKIP .*scout-integration \(skills root check failed: skills root .* is a symlink; not touching\)/);
    }
    expect(readFileSync(join(moved, "scout-integration", "SKILL.md"), "utf8")).toBe(template());
    expect(json(L.installed).skillsRoot).toBe(skillsRoot);
  });

  it("refuses test overrides on the real ~/.scout and changes nothing", async () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const before = listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"));
    const calls = fake.calls().length;
    for (const args of [["--yes"], ["--yes", "--agent-integration"], ["--dry-run", "--agent-integration"]]) {
      const r = await uninstall(args, env, { realHome: fx.home });
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/for test installs only and refused with the real ~\/\.scout/);
    }
    expect(listTree(fx.root).filter((f) => !f.startsWith("fake-bin/"))).toEqual(before);
    expect(registry()).toEqual({ scout: ours() });
    expect(fake.calls().length).toBe(calls);
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
    expect(status('MCP server "scout"')).toMatchObject({ status: "OK", detail: expect.stringContaining(GET_NOTE) });
    setRegistry({});
    expect(status('MCP server "scout"')).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/absent/) });
    setRegistry({ scout: { type: "stdio", command: "/bin/other-cmd", args: ["--secret-arg"], env: {} } });
    const foreign = status('MCP server "scout"');
    expect(foreign).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/foreign: scope: User config.*command differs from this install's/) });
    expect(foreign.detail).not.toMatch(/other-cmd|secret-arg/);
    fake.setMode("mcp-get-killed");
    expect(status('MCP server "scout"').status).toBe("WARN");
    const noBin = integrationChecks(doctor({ ...env, SCOUT_CLAUDE_BIN: undefined })).find((r) => r.label.includes("MCP registration"));
    expect(noBin.status).toBe("WARN");
  });

  it("fails a tampered mcp-registration entry without running claude", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const rec = json(L.installed);
    rec.files = rec.files.map((f) => (f.kind === "mcp-registration" ? { ...f, path: "/bin/sh -c" } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const calls = fake.calls().length;
    const results = doctor();
    expect(results.find((r) => r.label === "MCP registration")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/not one setup makes/) });
    expect(results.find((r) => r.label === "install record lists only paths setup writes").status).toBe("FAIL");
    expect(fake.calls().length).toBe(calls);
  });

  it("fails when test overrides are set on the real ~/.scout, without running claude", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const calls = fake.calls().length;
    const checks = integrationChecks(doctor(env, { realHome: fx.home }));
    expect(checks.find((r) => r.label.includes("test overrides"))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/SCOUT_SKILLS_ROOT and SCOUT_CLAUDE_BIN are for test installs only/) });
    expect(checks.find((r) => r.label === "MCP registration not checked").status).toBe("WARN");
    expect(fake.calls().length).toBe(calls);
  });

  it("fails when the recorded skillsRoot is not a real directory", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const rec = json(L.installed);
    writeFileSync(L.installed, JSON.stringify({ ...rec, skillsRoot: join(fx.root, "missing") }));
    expect(status("skillsRoot").status).toBe("FAIL");
  });
});
