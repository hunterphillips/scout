import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_AGENT_OUTPUT_JSON_SCHEMA } from "@scout/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBackend, selection } from "../testing/fakeBackend.js";
import { buildCodexArgv, createCodexLaunch, ensureCodexHome, renderCodexServerOverrides, type CodexLaunch } from "./launch.js";
import { CODEX_OUTPUT_SCHEMA, normalizeCodexOutput } from "./outputSchema.js";
import type { CodexProfile } from "./profile.js";
import { validateJobOutput } from "../outputValidation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "t".repeat(43);

/**
 * An npm/nvm-shaped install: `<dir>/codex` is a `#!/usr/bin/env node` script and `node` (this
 * test's own node) sits beside it, so `node` is reachable only through the CLI's directory.
 * Returns the codex path and a parent PATH with no `node` on it.
 */
function envNodeCodex(base: string): { codexPath: string; parentPath: string } {
  const bin = join(base, "nvm", "versions", "node", "v24.18.0", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const codexPath = join(bin, "codex");
  writeFileSync(
    codexPath,
    [
      "#!/usr/bin/env node",
      'const a = process.argv.slice(2).join(" ");',
      'if (a === "--version") process.stdout.write("codex-cli 0.155.1\\n");',
      'else if (a === "login status") process.stderr.write("Logged in using ChatGPT\\n");',
      'else { process.stderr.write("unexpected\\n"); process.exit(9); }',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const parentPath = ["/usr/bin", "/bin"].filter((d) => !existsSync(join(d, "node"))).join(":");
  return { codexPath, parentPath };
}


function setup(profileExtra: Partial<CodexProfile> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "scl-")));
  dirs.push(base);
  chmodSync(base, 0o700);
  const home = join(base, "h");
  mkdirSync(home, { mode: 0o700 });
  const codexPath = join(base, "codex");
  writeFileSync(codexPath, "#!/bin/sh\n", { mode: 0o755 });
  const parentEnv = { HOME: join(base, "u"), PATH: "/usr/bin:/bin", TMPDIR: "/tmp", OPENAI_API_KEY: "sk-SENTINEL", CODEX_API_KEY: "x", ANTHROPIC_API_KEY: "y", NODE_OPTIONS: "--inspect" };
  const codexHome = ensureCodexHome(home, parentEnv);
  if (!codexHome.ok) throw new Error(codexHome.reason);
  const profile: CodexProfile = { schemaVersion: 1, adapter: "codex", codexPath, model: "gpt-6-sol", ...profileExtra };
  const launch = (requestId = "job-1", p: CodexProfile = profile) =>
    createCodexLaunch({ home, profile: p, parentEnv, requestId, surface: { scout: { socketPath: join(base, "agent.sock"), token: TOKEN } }, codexHome: codexHome.codexHome, scoutMcpEntrypoint: "/opt/scout-mcp/main.js", bridgeEntrypoint: "/opt/scout-core/bridgeMain.js", nodePath: "/opt/node" });
  return { base, home, codexPath, parentEnv, profile, codexHome: codexHome.codexHome, launch };
}

const ok = (r: ReturnType<ReturnType<typeof setup>["launch"]>): CodexLaunch => {
  if (!r.ok) throw new Error(JSON.stringify(r.out));
  return r.launch;
};

const FORBIDDEN = ["--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "workspace-write", "danger-full-access", "--oss", "--add-dir", "resume", "fork"];

describe("codex launch", () => {
  it("the verified argv: read-only sandbox, explicit model and effort, both features off, Scout's server, schema file, prompt on stdin", () => {
    const s = setup();
    const l = ok(s.launch());
    const jobDir = join(s.home, "run", "jobs", "job-1");
    const cwd = join(s.home, "run", "agent-cwd");
    expect(l.jobDir).toBe(jobDir);
    expect(l.cwd).toBe(cwd);
    expect(l.argv).toEqual([
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never",
      "-C", cwd, "-s", "read-only", "-m", "gpt-6-sol",
      "-c", 'model_reasoning_effort="low"', "-c", "features.hooks=false", "-c", "project_doc_max_bytes=0", "-c", 'history.persistence="none"',
      "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false", "-c", 'web_search="disabled"', "-c", "features.shell_tool=false",
      "--disable", "apps",
      "-c", 'mcp_servers.scout.command="/opt/node"',
      "-c", `mcp_servers.scout.args=["/opt/scout-mcp/main.js","--socket","${join(s.base, "agent.sock")}","--token-file","${join(jobDir, "agent-token")}"]`,
      "-c", "mcp_servers.scout.required=true", "-c", "mcp_servers.scout.startup_timeout_sec=10", "-c", 'mcp_servers.scout.default_tools_approval_mode="approve"',
      "--output-schema", join(jobDir, "schema.json"), "-",
    ]);
    for (const f of FORBIDDEN) expect(l.argv).not.toContain(f);
    expect(l.argv.some((a) => a.startsWith("--dangerously"))).toBe(false);
  });

  it("the profile's reasoning effort replaces the default", () => {
    const l = ok(setup({ reasoningEffort: "xhigh" }).launch());
    expect(l.argv).toContain('model_reasoning_effort="xhigh"');
  });

  it("the child env: the allowlist plus CODEX_HOME and a per-job CODEX_SQLITE_HOME; no API key, no stray variable", () => {
    const s = setup();
    const l = ok(s.launch());
    expect(l.env).toEqual({ HOME: s.parentEnv.HOME, PATH: `${s.base}:${s.parentEnv.PATH}`, TMPDIR: "/tmp", CODEX_HOME: s.codexHome, CODEX_SQLITE_HOME: join(l.jobDir, "state") });
  });

  it("the child env's PATH leads with the codex directory, so an npm or nvm install finds its node under launchd's PATH", () => {
    const s = setup();
    const { codexPath, parentPath } = envNodeCodex(s.base);
    const r = createCodexLaunch({ home: s.home, profile: { ...s.profile, codexPath }, parentEnv: { ...s.parentEnv, PATH: parentPath }, requestId: "job-node", surface: { scout: { socketPath: join(s.base, "agent.sock"), token: TOKEN } }, codexHome: s.codexHome });
    const l = ok(r);
    expect(l.env.PATH).toBe(parentPath === "" ? join(codexPath, "..") : `${join(codexPath, "..")}:${parentPath}`);
    expect(spawnSync(codexPath, ["--version"], { env: { PATH: parentPath }, encoding: "utf8" }).status).toBe(127);
    const v = spawnSync(codexPath, ["--version"], { env: { ...l.env }, encoding: "utf8" });
    expect(v.status).toBe(0);
    expect(v.stdout).toBe("codex-cli 0.155.1\n");
    l.cleanup();
  });

  it("job files: 0600 token and schema, a 0700 state dir, in a 0700 job dir; cleanup removes it all", () => {
    const s = setup();
    const l = ok(s.launch());
    expect(statSync(l.jobDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(l.jobDir).sort()).toEqual(["agent-token", "schema.json", "state"]);
    expect(statSync(join(l.jobDir, "state")).mode & 0o777).toBe(0o700);
    for (const f of ["agent-token", "schema.json"]) expect(statSync(join(l.jobDir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(l.jobDir, "agent-token"), "utf8")).toBe(`${TOKEN}\n`);
    expect(JSON.parse(readFileSync(join(l.jobDir, "schema.json"), "utf8"))).toEqual(CODEX_OUTPUT_SCHEMA);
    l.cleanup();
    expect(existsSync(l.jobDir)).toBe(false);
  });

  it("selected tools add the bridge as a second server (required when a selection is) and write bridge.json 0600", () => {
    const s = setup();
    const b = fakeBackend(s.base, "notes", "honest");
    const l = ok(s.launch("job-2", { ...s.profile, tools: { connections: [b.connection], selections: [selection("notes", "lookup", false)] } }));
    const overrides = renderCodexServerOverrides(l.toolSurface);
    expect(overrides.filter((a) => a !== "-c")).toEqual([
      'mcp_servers.scout.command="/opt/node"',
      expect.stringMatching(/^mcp_servers\.scout\.args=\[/),
      "mcp_servers.scout.required=true",
      "mcp_servers.scout.startup_timeout_sec=10",
      'mcp_servers.scout.default_tools_approval_mode="approve"',
      'mcp_servers.scout_bridge.command="/opt/node"',
      `mcp_servers.scout_bridge.args=["/opt/scout-core/bridgeMain.js","--job","${join(l.jobDir, "bridge.json")}"]`,
      "mcp_servers.scout_bridge.required=false",
      "mcp_servers.scout_bridge.startup_timeout_sec=10",
      'mcp_servers.scout_bridge.default_tools_approval_mode="approve"',
    ]);
    expect(statSync(join(l.jobDir, "bridge.json")).mode & 0o777).toBe(0o600);
    expect(l.toolSurface.allowedTools.has("mcp__scout_bridge__lookup")).toBe(true);
  });

  it("server values are JSON-quoted, so a quote, backslash or newline in a path cannot break out of the TOML value", () => {
    const surface = { expected: [{ name: "scout", tools: [], required: true, optionalTools: [] }], mcpConfig: { mcpServers: { scout: { type: "stdio" as const, command: '/opt/a"b', args: ["x\\y", "line\nbreak"] } } } };
    expect(renderCodexServerOverrides(surface)).toContain('mcp_servers.scout.command="/opt/a\\"b"');
    expect(renderCodexServerOverrides(surface)).toContain('mcp_servers.scout.args=["x\\\\y","line\\nbreak"]');
    expect(() => renderCodexServerOverrides({ ...surface, mcpConfig: { mcpServers: { scout: { ...surface.mcpConfig.mcpServers.scout, env: { A: "b" } } } } })).toThrow();
  });

  it("failures by cause: binary gone, an existing job dir (never removed), a bad request id, no HOME", () => {
    const s = setup();
    expect(s.launch("job-1", { ...s.profile, codexPath: join(s.base, "missing") })).toMatchObject({ ok: false, out: { result: { status: "unavailable", reason: "agent_unavailable" } } });
    mkdirSync(join(s.home, "run", "jobs", "job-9"), { recursive: true, mode: 0o700 });
    writeFileSync(join(s.home, "run", "jobs", "job-9", "keep"), "x");
    expect(s.launch("job-9")).toMatchObject({ ok: false, out: { result: { status: "error", reason: "agent_failed" } } });
    expect(existsSync(join(s.home, "run", "jobs", "job-9", "keep"))).toBe(true);
    expect(s.launch("../x")).toMatchObject({ ok: false, out: { result: { reason: "unsupported_configuration" } } });
    const noHome = createCodexLaunch({ home: s.home, profile: s.profile, parentEnv: { PATH: "/bin" }, requestId: "job-3", surface: { scout: { socketPath: "/s", token: TOKEN } }, codexHome: s.codexHome });
    expect(noHome).toMatchObject({ ok: false, out: { result: { reason: "unsupported_configuration" } } });
  });

  it("a required selection whose connection cannot be prepared: tool_unavailable, job dir removed", () => {
    const s = setup();
    const b = fakeBackend(s.base, "notes", "honest");
    const r = s.launch("job-4", { ...s.profile, tools: { connections: [{ ...b.connection, command: join(s.base, "missing") }], selections: [selection("notes", "lookup", true)] } });
    expect(r).toMatchObject({ ok: false, out: { result: { status: "error", reason: "tool_unavailable" }, detail: "required_connection_unavailable" } });
    expect(existsSync(join(s.home, "run", "jobs", "job-4"))).toBe(false);
  });

  it("buildCodexArgv puts the overrides before --output-schema and the stdin marker last", () => {
    const argv = buildCodexArgv({ cwd: "/c", model: "m", reasoningEffort: "low", schemaFile: "/j/schema.json", surface: { expected: [], mcpConfig: { mcpServers: {} } } });
    expect(argv.slice(-3)).toEqual(["--output-schema", "/j/schema.json", "-"]);
  });
});

describe("codex output schema", () => {
  it("is strict: every property required, no pattern or length keywords", () => {
    const walk = (s: unknown): void => {
      if (s === null || typeof s !== "object") return;
      const o = s as Record<string, unknown>;
      for (const k of ["pattern", "minLength", "maxLength", "minItems", "maxItems"]) expect(o).not.toHaveProperty(k);
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(CODEX_OUTPUT_SCHEMA);
    expect(CODEX_OUTPUT_SCHEMA).not.toEqual(JOB_AGENT_OUTPUT_JSON_SCHEMA);
  });

  it("normalizes the strict empty answer to the contract's; everything else is left for validation", () => {
    const req = { candidates: [{ id: "c1", title: "A", labelQuality: "published" as const }], maxPicks: 3 };
    expect(normalizeCodexOutput({ status: "empty", items: [] })).toEqual({ status: "empty" });
    expect(normalizeCodexOutput({ status: "empty", items: [{ id: "c1", reason: "r" }] })).toEqual({ status: "empty" });
    expect(validateJobOutput(normalizeCodexOutput({ status: "empty", items: [] }), req)).toEqual({ status: "empty" });
    const okAnswer = { status: "ok", items: [{ id: "c1", reason: "fits" }] };
    expect(normalizeCodexOutput(okAnswer)).toBe(okAnswer);
    expect(validateJobOutput(normalizeCodexOutput({ status: "ok", items: [] }), req)).toMatchObject({ status: "invalid" });
    for (const v of [null, "x", [1], { status: "maybe" }]) expect(normalizeCodexOutput(v)).toBe(v);
  });
});
