// setup / uninstall / doctor for Codex: `--agent codex`, the Codex agent profile, and
// `--agent-integration` through `codex mcp add/get/remove`, against a temp home, a temp Codex
// home and the shared fake `codex` (its MCP registry is <temp Codex home>/config.toml).

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runChecks, runReport } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { listTree, makeFakeClaude, makeFakeCodex, makeFixture } from "./lib/test-fixture.mjs";
import { SKILL_TEMPLATE, sha256 } from "./lib/integration-skill.mjs";
import { readInstalledRecord } from "../packages/scout-core/dist/installedRecord.js";

const mode = (p) => statSync(p).mode & 0o777;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const sorted = (record) => ({ ...record, files: [...record.files].sort((a, b) => `${a.kind}${a.path}`.localeCompare(`${b.kind}${b.path}`)) });

function capture() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return { lines, out: push, err: push, text: () => lines.join("\n") };
}

let fx, codex, claude, codexHome, env, L;
beforeEach(() => {
  fx = makeFixture({ spaces: false });
  codex = makeFakeCodex(join(fx.root, "fake-codex"));
  claude = makeFakeClaude(join(fx.root, "fake-claude"));
  codexHome = join(fx.root, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  // A Codex-only test install: no claude to find.
  env = { ...fx.env, SCOUT_CLAUDE_BIN: undefined, SCOUT_CODEX_BIN: codex.path, SCOUT_CODEX_HOME: codexHome };
  L = layout({ env, scoutRoot: fx.scoutRoot });
});
afterEach(() => fx.cleanup());

const setup = (args = [], e = env, extra = {}) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env: e, out: c.out, err: c.err, claudeFallbacks: [], codexFallbacks: [], ...extra });
  return { code, ...c };
};
const uninstall = async (args = ["--yes"], e = env, extra = {}) => {
  const c = capture();
  const code = await runUninstall(args, { env: e, out: c.out, err: c.err, claudeFallbacks: [], codexFallbacks: [], ...extra });
  return { code, ...c };
};
const doctor = (e = env, extra = {}) => runChecks(e, { claudeFallbacks: [], codexFallbacks: [], ...extra });
const report = (e = env, extra = {}) => Object.fromEntries(runReport(e, { claudeFallbacks: [], codexFallbacks: [], ...extra }).map((s) => [s.title, s]));
const tree = () => listTree(fx.root).filter((f) => !f.startsWith("fake-"));

const configFile = () => join(codexHome, "config.toml");
/** The fake's registry: {name: {command, args, env?}} from config.toml. */
function registry() {
  if (!existsSync(configFile())) return {};
  const out = {};
  let cur = null;
  for (const line of readFileSync(configFile(), "utf8").split("\n")) {
    const t = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (t) cur = out[t[1]] = {};
    const kv = /^(command|args) = (.+)$/.exec(line);
    if (cur && kv) cur[kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}
const setRegistry = (servers) =>
  writeFileSync(configFile(), Object.entries(servers).map(([n, s]) => `[mcp_servers.${n}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args ?? [])}\n${s.extra ?? ""}`).join("\n"));
const ours = () => ({ command: process.execPath, args: [L.mcpMain] });
const skillPath = () => join(codexHome, "skills", "scout-integration", "SKILL.md");
const template = () => readFileSync(SKILL_TEMPLATE, "utf8");
const commandText = () => `${process.execPath} ${L.mcpMain}`;
const codexEntries = () => json(L.installed).files.filter((f) => f.agent === "codex");
const subcommands = () => codex.calls().map((a) => a.slice(0, 2).join(" "));

describe("setup --agent and the Codex profile", () => {
  it("--agent codex writes a Codex profile from the built constants, which the core accepts", async () => {
    const { loadAgentProfile } = await import("../packages/scout-core/dist/agents/profile.js");
    const r = setup(["--agent", "codex"], { ...env, SCOUT_CLAUDE_BIN: claude.path });
    expect(r.code, r.text()).toBe(0);
    expect(json(L.agentProfile)).toEqual({ schemaVersion: 1, adapter: "codex", codexPath: codex.path, model: "gpt-6-sol", reasoningEffort: "low" });
    expect(Object.keys(json(L.agentProfile))).toEqual(["schemaVersion", "adapter", "codexPath", "model", "reasoningEffort"]);
    expect(mode(L.agentProfile)).toBe(0o600);
    expect(loadAgentProfile(L.scoutHome)).toMatchObject({ adapter: "codex", codexPath: codex.path });
    const entry = json(L.installed).files.find((f) => f.kind === "agent-profile");
    expect(entry).toEqual({ path: L.agentProfile, kind: "agent-profile", sha256: sha256(readFileSync(L.agentProfile, "utf8")) });
    // Setup itself never runs codex.
    expect(codex.calls()).toEqual([]);
    expect(r.text()).toContain("npm run setup -- --agent codex --agent-integration");
    expect(r.text()).toMatch(/all of your Codex sessions/);
  });

  it("reads the model and reasoning effort from the built file, never a retyped literal", () => {
    writeFileSync(join(fx.scoutRoot, "packages/scout-core/dist/agents/codex/profile.js"), 'export const CODEX_ADAPTER_ID = "codex";\nexport const DEFAULT_CODEX_MODEL = "gpt-test-1";\nexport const DEFAULT_CODEX_REASONING_EFFORT = "high";\n');
    expect(setup(["--agent", "codex"]).code).toBe(0);
    expect(json(L.agentProfile)).toMatchObject({ model: "gpt-test-1", reasoningEffort: "high" });
  });

  it("refuses to write a Codex profile when scout-core is not built", () => {
    rmSync(join(fx.scoutRoot, "packages/scout-core/dist/agents/codex/profile.js"));
    const r = setup(["--agent", "codex"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/scout-core not built: .*codex\/profile\.js is missing/);
  });

  it("without --agent: Codex when only codex is found, Claude Code when both are", () => {
    let r = setup([]);
    expect(r.code, r.text()).toBe(0);
    expect(json(L.agentProfile).adapter).toBe("codex");
    const second = { ...env, SCOUT_HOME: join(fx.home, ".scout-second"), CHROME_NMH_DIR: join(fx.root, "nmh-second"), SCOUT_CLAUDE_BIN: claude.path };
    r = setup([], second);
    expect(r.code, r.text()).toBe(0);
    expect(json(layout({ env: second }).agentProfile)).toMatchObject({ adapter: "claude-code", claudePath: claude.path });
  });

  it("--agent codex without a codex writes no profile and names codex only", () => {
    const r = setup(["--agent", "codex"], { ...env, SCOUT_CODEX_BIN: undefined, SCOUT_CLAUDE_BIN: claude.path });
    expect(r.code, r.text()).toBe(0);
    expect(existsSync(L.agentProfile)).toBe(false);
    expect(r.text()).toMatch(/no agent profile is written \(the Scout home is not the real ~\/\.scout, so SCOUT_CODEX_BIN must name the codex to run\), so suggestions/);
  });

  it("rejects an unknown --agent", () => {
    for (const args of [["--agent", "other"], ["--agent"]]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/--agent needs one of claude-code, codex/);
    }
  });

  it("never rewrites an existing profile, and says --agent did not switch it", () => {
    expect(setup([], { ...env, SCOUT_CLAUDE_BIN: claude.path }).code).toBe(0);
    const before = readFileSync(L.agentProfile, "utf8");
    const r = setup(["--agent", "codex"]);
    expect(r.code, r.text()).toBe(0);
    expect(readFileSync(L.agentProfile, "utf8")).toBe(before);
    expect(r.text()).toMatch(/the existing agent profile names Claude Code, so Scout's jobs keep running there; --agent only picks the agent for a new profile/);
  });

  it("SCOUT_CODEX_BIN and SCOUT_CODEX_HOME are refused with the real ~/.scout", () => {
    const realEnv = { ...env, CHROME_NMH_DIR: undefined };
    for (const e of [realEnv, { ...realEnv, SCOUT_CODEX_HOME: undefined }, { ...realEnv, SCOUT_CODEX_BIN: undefined }]) {
      const dry = setup(["--dry-run", "--agent", "codex"], e, { realHome: fx.home });
      expect(dry.code, dry.text()).toBe(0);
      expect(dry.text()).toMatch(/no agent profile is written \(SCOUT_CODEX_.* for test installs only and refused with the real ~\/\.scout/);
      const r = setup(["--dry-run", "--agent", "codex", "--agent-integration"], e, { realHome: fx.home });
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/SCOUT_CODEX_.* for test installs only and refused with the real ~\/\.scout/);
    }
    expect(codex.calls()).toEqual([]);
    expect(existsSync(L.scoutHome)).toBe(false);
  });
});

describe("setup --agent codex --agent-integration", () => {
  it("--dry-run prints the plan, runs only `codex mcp get`, and changes nothing", () => {
    const before = tree();
    const r = setup(["--dry-run", "--agent", "codex", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`would register with Codex (${codexHome}): ${codex.path} mcp add scout -- ${commandText()}`);
    expect(r.text()).toContain(`would write ${skillPath()} (0600)`);
    expect(r.text()).toMatch(/registered in your Codex configuration: it is available in all of your Codex sessions/);
    expect(tree()).toEqual(before);
    expect(codex.calls()).toEqual([["mcp", "get", "scout", "--json"]]);
  });

  it("registers through `codex mcp add`, installs the skill under the Codex home, and records both with agent codex", () => {
    const r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(registry()).toEqual({ scout: ours() });
    expect(codex.calls()).toContainEqual(["mcp", "add", "scout", "--", process.execPath, L.mcpMain]);
    expect(subcommands().filter((s) => !s.startsWith("mcp "))).toEqual([]);
    expect(readFileSync(skillPath(), "utf8")).toBe(template());
    expect(mode(skillPath())).toBe(0o600);
    expect(mode(join(codexHome, "skills", "scout-integration"))).toBe(0o700);
    expect(codexEntries()).toEqual([
      { path: skillPath(), kind: "skill", agent: "codex", sha256: sha256(template()) },
      { path: commandText(), kind: "mcp-registration", agent: "codex", name: "scout", codexHome },
    ]);
    // Claude Code's skills root stays unset: the core exports no wrappers for Codex.
    expect(json(L.installed).skillsRoot).toBeUndefined();
    expect(readInstalledRecord(L.scoutHome)).toEqual({});
    expect(claude.calls()).toEqual([]);
    expect(r.text()).toMatch(/Start a new Codex session to load it/);
    expect(r.text()).not.toMatch(/Claude Code/);
    const checks = doctor().filter((c) => c.section === "agent integration");
    expect(checks.map((c) => c.label)).toEqual(["Codex integration skill is exactly the installed one", 'Codex MCP server "scout" is configured and is this install\'s']);
    expect(checks.filter((c) => c.status !== "OK")).toEqual([]);
  });

  it("follows the profile's adapter when --agent is not given, and is idempotent", () => {
    expect(setup(["--agent", "codex"]).code).toBe(0);
    expect(setup(["--agent-integration"]).code).toBe(0);
    const first = json(L.installed);
    const r = setup(["--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`kept  Codex MCP server "scout": ${commandText()}`);
    expect(codex.calls().filter((a) => a[1] === "add")).toHaveLength(1);
    expect(sorted(json(L.installed))).toEqual(sorted(first));
    expect(setup().code).toBe(0);
    expect(sorted(json(L.installed))).toEqual(sorted(first));
  });

  it("replaces this install's earlier entry (recorded command) instead of refusing it", () => {
    expect(setup(["--agent", "codex", "--agent-integration"]).code).toBe(0);
    setRegistry({ scout: { command: "/old/node", args: [L.mcpMain] } });
    const rec = json(L.installed);
    rec.files = rec.files.map((f) => (f.kind === "mcp-registration" ? { ...f, path: `/old/node ${L.mcpMain}` } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(registry()).toEqual({ scout: ours() });
    expect(codexEntries().filter((f) => f.kind === "mcp-registration")).toEqual([{ path: commandText(), kind: "mcp-registration", agent: "codex", name: "scout", codexHome }]);
  });

  it("refuses a foreign `scout` entry without printing its command, and writes nothing", () => {
    setRegistry({ scout: { command: "/usr/local/bin/someone-else", args: ["--secret-flag"] } });
    const before = tree();
    for (const args of [["--agent", "codex", "--agent-integration"], ["--agent", "codex", "--agent-integration", "--dry-run"]]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/Codex already has an MCP server named "scout" that is not this install's \(command differs from this install's \(sha256 [0-9a-f]{12}\)\)/);
      expect(r.text()).not.toMatch(/someone-else|secret-flag/);
    }
    expect(tree()).toEqual(before);
    expect(codex.calls().every((a) => a[1] === "get")).toBe(true);
  });

  it("an entry with its own env is not ours", () => {
    setRegistry({ scout: { ...ours(), extra: 'env = { "A" = "1" }\n' } });
    const r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/not this install's/);
  });

  it("refuses when `codex mcp get` cannot tell (killed), writing nothing", () => {
    setRegistry({ scout: { command: "/x", args: [] } });
    codex.setMode("mcp-get-killed");
    const r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/codex mcp get scout` could not tell/);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses a missing Codex home and a conflicting skill dir", () => {
    let r = setup(["--agent", "codex", "--agent-integration"], { ...env, SCOUT_CODEX_HOME: join(fx.root, "no-such-home") });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/the Codex home .*no-such-home does not exist; run `codex login` once/);
    mkdirSync(join(codexHome, "skills", "scout-integration"), { recursive: true });
    writeFileSync(skillPath(), "someone else's skill");
    r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/not this install's skill/);
    expect(readFileSync(skillPath(), "utf8")).toBe("someone else's skill");
    expect(existsSync(L.installed)).toBe(false);
    expect(registry()).toEqual({});
  });

  it("a test install needs both SCOUT_CODEX_HOME and SCOUT_CODEX_BIN", () => {
    for (const drop of ["SCOUT_CODEX_HOME", "SCOUT_CODEX_BIN"]) {
      const r = setup(["--agent", "codex", "--agent-integration"], { ...env, [drop]: undefined });
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/needs both SCOUT_CODEX_HOME and SCOUT_CODEX_BIN/);
    }
    expect(codex.calls()).toEqual([]);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("a failed `codex mcp add` that still wrote the entry fails setup, stays recorded, and uninstall removes it", async () => {
    codex.setMode("mcp-add-fail");
    const r = setup(["--agent", "codex", "--agent-integration"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/codex mcp add` failed/);
    expect(registry()).toEqual({ scout: ours() });
    expect(codexEntries().map((f) => f.kind).sort()).toEqual(["mcp-registration", "skill"]);
    codex.setMode("");
    const u = await uninstall(["--yes", "--agent-integration"]);
    expect(u.code, u.text()).toBe(0);
    expect(registry()).toEqual({});
  });

  it("Claude Code and Codex integrations are recorded side by side, one each", async () => {
    const skillsRoot = join(fx.root, "claude-config", "skills");
    const both = { ...env, SCOUT_CLAUDE_BIN: claude.path, SCOUT_SKILLS_ROOT: skillsRoot };
    expect(setup(["--agent-integration"], both).code).toBe(0); // the profile is Claude Code's
    expect(setup(["--agent", "codex", "--agent-integration"], both).code).toBe(0);
    const kinds = json(L.installed).files.filter((f) => ["skill", "mcp-registration"].includes(f.kind)).map((f) => `${f.agent}:${f.kind}`).sort();
    expect(kinds).toEqual(["claude-code:mcp-registration", "claude-code:skill", "codex:mcp-registration", "codex:skill"]);
    expect(json(L.installed).skillsRoot).toBe(skillsRoot);
    expect(doctor(both).filter((c) => c.section === "agent integration" && c.status !== "OK")).toEqual([]);
    const u = await uninstall(["--yes", "--agent-integration"], both);
    expect(u.code, u.text()).toBe(0);
    expect(registry()).toEqual({});
    expect(json(join(fx.home, ".claude.json")).mcpServers).toEqual({});
    expect(existsSync(skillPath())).toBe(false);
    expect(existsSync(join(skillsRoot, "scout-integration"))).toBe(false);
    expect(json(L.installed).files.some((f) => ["skill", "mcp-registration"].includes(f.kind))).toBe(false);
    expect(json(L.installed).skillsRoot).toBeUndefined();
  });
});

describe("uninstall and the Codex integration", () => {
  const install = () => {
    expect(setup(["--agent", "codex", "--agent-integration"]).code).toBe(0);
    setRegistry({ ...registry(), other: { command: "/bin/other", args: [] } });
    mkdirSync(join(codexHome, "skills", "someone-skill"));
    writeFileSync(join(codexHome, "skills", "someone-skill", "SKILL.md"), "x");
  };

  it("--agent-integration removes only Scout's entry and skill, through `codex mcp remove`", async () => {
    install();
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`removed Codex MCP server "scout" (was exactly ${commandText()})`);
    expect(r.text()).toMatch(/mcp-registration .* \(Codex\)/);
    expect(codex.calls()).toContainEqual(["mcp", "remove", "scout"]);
    expect(Object.keys(registry())).toEqual(["other"]);
    expect(existsSync(join(codexHome, "skills", "scout-integration"))).toBe(false);
    expect(existsSync(join(codexHome, "skills", "someone-skill", "SKILL.md"))).toBe(true);
    expect(codexEntries()).toEqual([]);
    expect(existsSync(L.agentProfile)).toBe(true);
  });

  it("--dry-run says what it would remove and changes nothing", async () => {
    install();
    const before = tree();
    const r = await uninstall(["--dry-run", "--agent-integration"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`would remove Codex MCP server "scout" (still exactly ${commandText()})`);
    expect(r.text()).toContain(`would remove ${join(codexHome, "skills", "scout-integration")}`);
    expect(tree()).toEqual(before);
    expect(codex.calls().some((a) => a[1] === "remove")).toBe(false);
  });

  it("leaves an entry that changed since setup, and a modified skill, and exits 2", async () => {
    install();
    setRegistry({ ...registry(), scout: { ...ours(), args: [L.mcpMain, "--socket", "/elsewhere"] } });
    writeFileSync(skillPath(), template() + "\nedited\n");
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(2);
    expect(r.text()).toMatch(/SKIP Codex MCP server "scout" \(changed; not Scout's/);
    expect(r.text()).toMatch(/SKIP .*scout-integration \(changed since setup/);
    expect(registry().scout.args).toEqual([L.mcpMain, "--socket", "/elsewhere"]);
    expect(codex.calls().some((a) => a[1] === "remove")).toBe(false);
    expect(codexEntries().map((f) => f.kind).sort()).toEqual(["mcp-registration", "skill"]);
  });

  it("leaves the entry alone when `get` is killed or times out", async () => {
    install();
    for (const [m, extra] of [["mcp-get-killed", {}], ["mcp-get-hang", { mcpTimeoutMs: 500 }]]) {
      codex.setMode(m);
      const r = await uninstall(["--yes", "--agent-integration"], env, extra);
      expect(r.code).toBe(2);
      expect(r.text()).toMatch(/codex mcp get could not tell/);
      expect(registry().scout).toEqual(ours());
    }
    expect(codex.calls().some((a) => a[1] === "remove")).toBe(false);
  });

  it("touches nothing recorded for another Codex home", async () => {
    install();
    const other = join(fx.root, "other-codex-home");
    mkdirSync(other);
    const r = await uninstall(["--yes", "--agent-integration"], { ...env, SCOUT_CODEX_HOME: other });
    expect(r.code).toBe(2);
    expect(r.text()).toContain(`SKIP Codex MCP server "scout" (recorded for the Codex home ${codexHome}, not ${other}; not touching)`);
    expect(r.text()).toMatch(/SKIP .*scout-integration \(not under this environment's Codex home/);
    expect(registry().scout).toEqual(ours());
    expect(existsSync(skillPath())).toBe(true);
  });

  it("ignores a tampered skill entry", async () => {
    install();
    const victim = join(fx.root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "SKILL.md"), template());
    const rec = json(L.installed);
    rec.files = rec.files.map((f) => (f.kind === "skill" ? { ...f, path: join(victim, "SKILL.md") } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = await uninstall(["--yes", "--agent-integration"]);
    expect(r.code).toBe(2);
    expect(readFileSync(join(victim, "SKILL.md"), "utf8")).toBe(template());
  });

  it("refuses the Codex test overrides on the real ~/.scout and changes nothing", async () => {
    install();
    const before = tree();
    const calls = codex.calls().length;
    for (const args of [["--yes"], ["--yes", "--agent-integration"], ["--dry-run", "--agent-integration"]]) {
      const r = await uninstall(args, { ...env, CHROME_NMH_DIR: undefined }, { realHome: fx.home });
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/SCOUT_CODEX_BIN and SCOUT_CODEX_HOME are for test installs only and refused with the real ~\/\.scout/);
    }
    expect(tree()).toEqual(before);
    expect(codex.calls().length).toBe(calls);
  });

  it("the full uninstall removes Scout's private Codex home and never the user's login file", async () => {
    install();
    const userAuth = join(fx.root, "user-codex", "auth.json");
    mkdirSync(join(fx.root, "user-codex"));
    writeFileSync(userAuth, "{}", { mode: 0o600 });
    mkdirSync(L.codexPrivateHome, { recursive: true, mode: 0o700 });
    symlinkSync(userAuth, join(L.codexPrivateHome, "auth.json"));
    writeFileSync(join(L.codexPrivateHome, "models_cache.json"), "{}");
    const dry = await uninstall(["--dry-run"]);
    expect(dry.text()).toContain(`would remove ${L.codexPrivateHome} (Scout's private Codex home; your Codex login is not touched)`);
    expect(existsSync(L.codexPrivateHome)).toBe(true);
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(0);
    expect(existsSync(L.codexPrivateHome)).toBe(false);
    expect(readFileSync(userAuth, "utf8")).toBe("{}");
    expect(registry()).toEqual({ other: { command: "/bin/other", args: [] } });
    expect(existsSync(L.installed)).toBe(false);
  });
});

describe("doctor with a Codex profile", () => {
  const codexLog = () => codex.calls();
  const authLink = () => join(L.codexPrivateHome, "auth.json");
  const linkTo = (target) => {
    mkdirSync(L.codexPrivateHome, { recursive: true, mode: 0o700 });
    rmSync(authLink(), { force: true });
    symlinkSync(target, authLink());
  };
  const cliCheck = (label) => report().CLI.checks.find((c) => c.label === label);
  const LINK = "Scout's Codex home links to your Codex login";

  beforeEach(() => {
    expect(setup(["--agent", "codex"]).code).toBe(0);
  });

  it("checks the codex binary and its version, and asks codex nothing else", () => {
    const cli = report().CLI;
    expect(cli.summary).toBe(`${codex.path} 0.155.1 (verified 0.155.1)`);
    expect(cli.checks.find((c) => c.label === "agent profile names an executable codex").status).toBe("OK");
    expect(cli.checks.find((c) => c.label === "codex version matches the verified one (advisory)").status).toBe("OK");
    const newer = report(env, { codexVersion: () => "0.160.0" }).CLI;
    expect(newer.checks.find((c) => c.status === "WARN" && /codex version/.test(c.label)).detail).toMatch(/verified with 0\.155\.1\. Jobs still run/);
    expect(cli.checks.some((c) => /claude/.test(c.label))).toBe(false);
    expect(new Set(codexLog().map((a) => a.join(" ")))).toEqual(new Set(["--version"]));
  });

  it("fails a codexPath that is not an executable", () => {
    writeFileSync(L.agentProfile, JSON.stringify({ ...json(L.agentProfile), codexPath: join(fx.root, "missing", "codex") }));
    const failed = doctor().filter((c) => c.status === "FAIL").map((c) => c.label);
    expect(failed).toEqual(["agent profile names an executable codex"]);
  });

  it("reports the private home's auth link: not made yet, intact, dangling, or not a link", () => {
    expect(cliCheck(LINK)).toMatchObject({ status: "WARN", detail: expect.stringMatching(/not created yet/) });
    const userAuth = join(fx.root, "user-auth.json");
    writeFileSync(userAuth, "{}", { mode: 0o600 });
    chmodSync(userAuth, 0o600);
    linkTo(userAuth);
    expect(cliCheck(LINK)).toMatchObject({ status: "OK", detail: expect.stringContaining(`-> ${userAuth} (0600`) });
    chmodSync(userAuth, 0o644);
    expect(cliCheck(LINK).status).toBe("FAIL");
    linkTo(join(fx.root, "gone.json"));
    expect(cliCheck(LINK)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/missing; log in with `codex login`/) });
    rmSync(authLink());
    writeFileSync(authLink(), "{}");
    expect(cliCheck(LINK)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/is not a link/) });
    expect(lstatSync(authLink()).isFile()).toBe(true);
    // Never `codex login status`: doctor runs no readiness check.
    expect(codexLog().some((a) => a[0] === "login")).toBe(false);
  });

  it("billing names the agent of the last logged check; suggestions speak of the agent's quota", () => {
    mkdirSync(L.logsDir, { recursive: true });
    writeFileSync(L.diagnosticsLog, JSON.stringify({ t: 5, event: "agent_preflight", adapter: "codex", verdict: "subscription", reasons: 0, cliVersion: "0.155.1" }) + "\n");
    expect(report().billing).toMatchObject({ status: "ok", summary: "last preflight: subscription (Codex, CLI 0.155.1)" });
    writeFileSync(L.scoutConfig, JSON.stringify({ ...json(L.scoutConfig), destinations: ["docs.stripe.com"] }));
    expect(report().suggestions.checks[0].detail).toMatch(/spends your agent's quota/);
    expect(JSON.stringify(report())).not.toMatch(/Claude quota/);
  });

  it("reports the Codex entry as ours, absent, foreign or unknown", () => {
    expect(setup(["--agent-integration"]).code).toBe(0);
    const label = 'Codex MCP server "scout" is configured and is this install\'s';
    const reg = () => doctor().find((c) => c.label.startsWith('Codex MCP server "scout"'));
    expect(reg()).toMatchObject({ status: "OK", label });
    setRegistry({});
    expect(reg()).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/absent/) });
    setRegistry({ scout: { command: "/bin/other-cmd", args: ["--secret-arg"] } });
    expect(reg()).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^foreign: command differs/) });
    expect(reg().detail).not.toMatch(/other-cmd|secret-arg/);
    setRegistry({ scout: ours() });
    codex.setMode("mcp-get-killed");
    expect(reg().status).toBe("WARN");
    codex.setMode("");
    writeFileSync(skillPath(), "edited");
    expect(doctor().find((c) => c.label === "Codex integration skill is exactly the installed one")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/modified$/) });
    // Install record: the Codex entries are paths setup writes.
    expect(doctor().find((c) => c.label === "install record lists only paths setup writes").status).toBe("OK");
  });
});
