// `cli.js agent ...` end to end through runCli, against fake-backend.mjs behind a shell
// wrapper in a temp dir (the wrapper reads its mode from a file, so a schema can change while
// the reviewed command and argv stay the same). No model, no real backend, temp SCOUT_HOME.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { AGENT_PROFILE_LOCK_FILE } from "./profile.js";
import { type AgentStatus } from "./profileCli.js";
import { agentProfilePath, DEFAULT_AGENT_MODEL, loadAgentProfile, writeAgentProfile } from "./profile.js";
import { FAKE_BACKEND, LOOKUP_SCHEMA, type BackendLogLine } from "./testing/fakeBackend.js";
import { schemaHash } from "./toolProfile.js";

const DEF_SECRET = "SENTINEL-DEF-LITERAL-5d2c";
const CFG_SECRET = "SENTINEL-CONFIG-VALUE-a81f";
const ROTATED = "SENTINEL-ROTATED-VALUE-0b77";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  home: string;
  def: string;
  config: string;
  wrapper: string;
  modeFile: string;
  log: string;
  outputs: string[];
  run(argv: string[], opts?: { env?: NodeJS.ProcessEnv; getuid?: () => number }): Promise<{ code: number; out: string; err: string }>;
  writeDef(body: Record<string, unknown>, mode?: number): void;
  logLines(): BackendLogLine[];
  status(): Promise<AgentStatus>;
}

function writeWrapper(wrapper: string, modeFile: string, log: string, extra = ""): void {
  writeFileSync(wrapper, `#!/bin/sh\n${extra}exec '${process.execPath}' '${FAKE_BACKEND}' --mode "$(/bin/cat '${modeFile}')" --log '${log}' "$@"\n`);
  chmodSync(wrapper, 0o755);
}

function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scout-agentcli-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  writeAgentProfile(home, { schemaVersion: 1, adapter: "claude-code", claudePath: "/opt/bin/claude", model: DEFAULT_AGENT_MODEL });
  const modeFile = join(dir, "mode");
  writeFileSync(modeFile, "honest");
  const log = join(dir, "backend.log");
  const wrapper = join(dir, "notes-mcp");
  writeWrapper(wrapper, modeFile, log);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ notes: { token: CFG_SECRET } }), { mode: 0o600 });
  const def = join(dir, "notes.json");
  const outputs: string[] = [];
  const f: Fixture = {
    dir,
    home,
    def,
    config,
    wrapper,
    modeFile,
    log,
    outputs,
    async run(argv, opts = {}) {
      let out = "";
      let err = "";
      const code = await runCli(["agent", ...argv], {
        stdout: (t) => void (out += t),
        stderr: (t) => void (err += t),
        env: opts.env ?? { SCOUT_HOME: home },
        deps: { clock: { now: () => Date.parse("2026-10-01T12:00:00Z") }, agent: { inspectLimits: { startupMs: 5000, overallMs: 10_000, stopGraceMs: 2000 }, ...(opts.getuid ? { getuid: opts.getuid } : {}) } },
      });
      outputs.push(out, err);
      return { code, out, err };
    },
    writeDef(body, mode = 0o600) {
      writeFileSync(def, JSON.stringify(body));
      chmodSync(def, mode);
    },
    logLines: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as BackendLogLine)
        : [],
    async status() {
      const r = await f.run(["status", "--json"]);
      expect(r.code).toBe(0);
      return JSON.parse(r.out) as AgentStatus;
    },
  };
  f.writeDef({ id: "notes", command: wrapper, args: ["--stdio"], env: { NOTES_TOKEN: DEF_SECRET, NOTES_API: { file: config, pointer: "/notes/token" }, LANG: "C" }, cwd: dir });
  return f;
}

const profileText = (f: Fixture): string => readFileSync(agentProfilePath(f.home), "utf8");
const toolsOf = (f: Fixture) => loadAgentProfile(f.home).tools;

describe("agent inspect", () => {
  it("without --allow-start shows the command and env sources, exits 3, and starts nothing", async () => {
    const f = fixture();
    const before = profileText(f);
    const r = await f.run(["inspect", f.def]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(f.wrapper);
    expect(r.out).toContain("NOTES_TOKEN");
    expect(r.out).toContain(f.config);
    expect(f.logLines()).toEqual([]);
    expect(profileText(f)).toBe(before);
  });

  it("with --allow-start lists the tools, stops the backend, and enables nothing", async () => {
    const f = fixture();
    const r = await f.run(["inspect", f.def, "--allow-start"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lookup");
    const tools = toolsOf(f)!;
    expect(tools.selections).toEqual([]);
    const conn = tools.connections[0]!;
    expect(conn.inspectedTools?.map((t) => t.name)).toEqual(["lookup", "secret_tool", "peek"]);
    expect(conn.inspectedTools?.[0]?.schemaHash).toBe(schemaHash(LOOKUP_SCHEMA));
    expect(conn.resolvedCommand?.path).toBe(f.wrapper);
    expect(conn.definitionFile).toBe(f.def);
    // The backend ran in the definition's cwd, got both values, and is gone.
    const start = f.logLines()[0]!;
    expect(start.cwd).toBe(f.dir);
    expect(start.env?.NOTES_TOKEN).toBe(DEF_SECRET);
    expect(start.env?.NOTES_API).toBe(CFG_SECRET);
    expect(() => process.kill(start.pid!, 0)).toThrow();
  });

  it("refuses process-injection names without starting anything", async () => {
    const f = fixture();
    f.writeDef({ id: "notes", command: f.wrapper, env: { NODE_OPTIONS: "--require /tmp/x.js", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" } });
    const r = await f.run(["inspect", f.def, "--allow-start"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NODE_OPTIONS");
    expect(r.err).toContain("DYLD_INSERT_LIBRARIES");
    expect(f.logLines()).toEqual([]);
  });

  it("an unresolvable binding makes the connection unavailable before any launch", async () => {
    const f = fixture();
    chmodSync(f.config, 0o644);
    const r = await f.run(["inspect", f.def, "--allow-start"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOTES_API");
    expect(r.err).toContain("0600");
    expect(f.logLines()).toEqual([]);
    expect(toolsOf(f)).toBeUndefined();
  });

  it("a backend that never answers is unavailable within the deadline, and the profile is unchanged", async () => {
    const f = fixture();
    writeFileSync(f.modeFile, "never-start");
    let out = "";
    const code = await runCli(["agent", "inspect", f.def, "--allow-start"], {
      stdout: (t) => void (out += t),
      stderr: (t) => void (out += t),
      env: { SCOUT_HOME: f.home },
      deps: { agent: { inspectLimits: { startupMs: 1500, overallMs: 2000, stopGraceMs: 300 } } },
    });
    expect(code).toBe(1);
    expect(out).toContain("unavailable");
    expect(toolsOf(f)).toBeUndefined();
    const pid = f.logLines()[0]!.pid!;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("the backend environment does not depend on the CLI's own environment", async () => {
    const f = fixture();
    expect((await f.run(["inspect", f.def, "--allow-start"], { env: { SCOUT_HOME: f.home } })).code).toBe(0);
    expect(
      (
        await f.run(["inspect", f.def, "--allow-start"], {
          env: { SCOUT_HOME: f.home, PATH: "/usr/bin:/bin", HOME: "/Users/someone", NODE_OPTIONS: "--require /tmp/x.js", SCOUT_TEST_INHERITED: "leak" },
        })
      ).code,
    ).toBe(0);
    const [envA, envB] = f.logLines().flatMap((l) => (l.env ? [l.env] : []));
    expect(envB).toEqual(envA);
    expect(envB!.SCOUT_TEST_INHERITED).toBeUndefined();
    expect(envB!.NODE_OPTIONS).toBeUndefined();
    expect(envB!.HOME).toBeUndefined();
    expect(envB).toMatchObject({ NOTES_TOKEN: DEF_SECRET, NOTES_API: CFG_SECRET, LANG: "C" });
  });

  it("a backend that asks for input while starting is unavailable (auth_prompt): exit 1 and nothing stored", async () => {
    const f = fixture();
    writeFileSync(f.modeFile, "elicit-init");
    const before = profileText(f);
    const r = await f.run(["inspect", f.def, "--allow-start"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("auth_prompt");
    expect(r.err).toContain("never answers");
    expect(r.out).not.toContain("listed");
    expect(profileText(f)).toBe(before);
    expect(toolsOf(f)).toBeUndefined();
    expect(f.logLines().some((l) => l.method === "tools/list")).toBe(false);
    expect(() => process.kill(f.logLines()[0]!.pid!, 0)).toThrow();
    expect((await f.status()).connections).toEqual([]);
  });

  it("prints argv quoted with control characters replaced, and warns (without refusing) about secret-looking arguments", async () => {
    const f = fixture();
    f.writeDef({ id: "notes", command: f.wrapper, args: ["--stdio", "--api-key=abc", "a\u001b[2Jb"], env: { LANG: "C" } });
    const r = await f.run(["inspect", f.def]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('args         "--stdio" "--api-key=abc" "a [2Jb"');
    expect(r.out).not.toContain("\u001b");
    expect(r.err).toContain("warning: argument 2 looks like it may name or carry a secret");
    expect(r.err).not.toContain("argument 1 ");
    expect(r.err).not.toContain("argument 3 ");
    // A flag spelled --password is warned about too.
    f.writeDef({ id: "notes", command: f.wrapper, args: ["--password", "secret2"], env: { LANG: "C" } });
    expect((await f.run(["inspect", f.def])).err).toContain("warning: argument 1 ");
  });

  it("refuses a definition owned by another user", async () => {
    const f = fixture();
    const r = await f.run(["inspect", f.def], { getuid: () => (process.getuid?.() ?? 0) + 1 });
    expect(r.code).toBe(1);
  });
});

describe("agent enable / disable", () => {
  it("enable needs a prior inspection", async () => {
    const f = fixture();
    const r = await f.run(["enable", "notes", "lookup", "--unattended-read"]);
    expect(r.code).toBe(1);
    expect(toolsOf(f)).toBeUndefined();
  });

  it("enable needs --unattended-read", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    const r = await f.run(["enable", "notes", "lookup"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--unattended-read");
    expect(toolsOf(f)!.selections).toEqual([]);
  });

  it("enable freezes the inspected schema; disable removes it; each bumps the revisions", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    const rev0 = toolsOf(f)!.revision!;
    const crev0 = toolsOf(f)!.connections[0]!.revision!;

    expect((await f.run(["enable", "notes", "lookup", "--unattended-read", "--required"])).code).toBe(0);
    let tools = toolsOf(f)!;
    expect(tools.selections).toEqual([
      {
        connectionId: "notes",
        toolName: "lookup",
        description: "Look something up",
        inputSchema: LOOKUP_SCHEMA,
        schemaHash: schemaHash(LOOKUP_SCHEMA),
        required: true,
        unattendedReadDeclared: true,
        selectedAt: "2026-10-01T12:00:00.000Z",
      },
    ]);
    expect(tools.revision).toBe(rev0 + 1);
    expect(tools.connections[0]!.revision).toBe(crev0 + 1);
    expect((await f.run(["enable", "notes", "nope", "--unattended-read"])).code).toBe(1);

    expect((await f.run(["disable", "notes", "lookup"])).code).toBe(0);
    tools = toolsOf(f)!;
    expect(tools.selections).toEqual([]);
    expect(tools.revision).toBe(rev0 + 2);
    expect((await f.run(["disable", "notes", "lookup"])).code).toBe(1);
  });
});

describe("agent refresh", () => {
  it("needs --allow-start", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    const starts = f.logLines().filter((l) => l.pid).length;
    expect((await f.run(["refresh", "notes"])).code).toBe(3);
    expect(f.logLines().filter((l) => l.pid).length).toBe(starts);
  });

  it("a changed schema deselects that tool and reports it; unchanged tools stay selected", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read", "--required"]);
    await f.run(["enable", "notes", "peek", "--unattended-read"]);
    const rev = toolsOf(f)!.revision!;
    writeFileSync(f.modeFile, "schema-change");
    const r = await f.run(["refresh", "notes", "--allow-start"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deselected lookup: schema_changed/);
    const tools = toolsOf(f)!;
    expect(tools.selections.map((s) => s.toolName)).toEqual(["peek"]);
    expect(tools.revision).toBe(rev + 1);
    // Selecting it again freezes the new schema.
    expect((await f.run(["enable", "notes", "lookup", "--unattended-read"])).code).toBe(0);
    expect(toolsOf(f)!.selections.find((s) => s.toolName === "lookup")?.schemaHash).not.toBe(schemaHash(LOOKUP_SCHEMA));
  });

  it("a changed command or argv deselects every tool of the connection", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read"]);
    f.writeDef({ id: "notes", command: f.wrapper, args: ["--other"], env: { NOTES_TOKEN: DEF_SECRET, NOTES_API: { file: f.config, pointer: "/notes/token" }, LANG: "C" }, cwd: f.dir });
    const r = await f.run(["refresh", "notes", "--allow-start"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deselected lookup: definition_changed/);
    expect(toolsOf(f)!.selections).toEqual([]);
  });

  it("an auth prompt keeps the last inspection, deselects every tool, and status shows the reason until a refresh succeeds", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read", "--required"]);
    await f.run(["enable", "notes", "peek", "--unattended-read"]);
    const before = toolsOf(f)!;
    const conn0 = before.connections[0]!;

    writeFileSync(f.modeFile, "sample-list");
    const r = await f.run(["refresh", "notes", "--allow-start"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("auth_prompt");
    expect(r.err).toMatch(/deselected lookup/);
    expect(r.err).toMatch(/deselected peek/);
    const tools = toolsOf(f)!;
    expect(tools.selections).toEqual([]);
    expect(tools.revision).toBe(before.revision! + 1);
    const conn = tools.connections[0]!;
    expect(conn.revision).toBe(conn0.revision! + 1);
    expect(conn.inspectedAt).toBe(conn0.inspectedAt);
    expect(conn.inspectedTools).toEqual(conn0.inspectedTools);
    expect(conn.unavailable).toEqual({ reason: "auth_prompt", at: "2026-10-01T12:00:00.000Z" });
    expect(readdirSync(f.home).filter((n) => n.startsWith("agent-"))).toEqual(["agent-profile.json"]);

    const c = (await f.status()).connections[0]!;
    expect(c).toMatchObject({ id: "notes", available: false, unavailableReason: "auth_prompt", selected: [] });
    expect((await f.run(["status"])).out).toContain("UNAVAILABLE: auth_prompt");
    // Nothing can be selected from the kept inspection meanwhile.
    const en = await f.run(["enable", "notes", "lookup", "--unattended-read"]);
    expect(en.code).toBe(1);
    expect(en.err).toContain("auth_prompt");
    expect(toolsOf(f)!.selections).toEqual([]);

    // Re-inspecting the known id with a prompt keeps it unavailable; a clean refresh clears it.
    writeFileSync(f.modeFile, "elicit-init");
    expect((await f.run(["inspect", f.def, "--allow-start"])).code).toBe(1);
    expect((await f.status()).connections[0]!.unavailableReason).toBe("auth_prompt");
    writeFileSync(f.modeFile, "honest");
    expect((await f.run(["refresh", "notes", "--allow-start"])).code).toBe(0);
    const ok = (await f.status()).connections[0]!;
    expect(ok.available).toBe(true);
    expect(ok.unavailableReason).toBeUndefined();
    expect(toolsOf(f)!.connections[0]!.unavailable).toBeUndefined();
    expect((await f.run(["enable", "notes", "lookup", "--unattended-read"])).code).toBe(0);
  });

  it("enable refuses a connection whose profile entry carries the auth-prompt mark, even one written by hand", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    const profile = loadAgentProfile(f.home);
    profile.tools!.connections[0]!.unavailable = { reason: "auth_prompt", at: "2026-10-01T11:00:00.000Z" };
    writeAgentProfile(f.home, profile);
    const before = profileText(f);
    const r = await f.run(["enable", "notes", "lookup", "--unattended-read"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unavailable (auth_prompt)");
    expect(profileText(f)).toBe(before);
    expect((await f.status()).connections[0]).toMatchObject({ available: false, unavailableReason: "auth_prompt" });
  });

  it("a rotated credential at the same binding keeps the selection", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read"]);
    writeFileSync(f.config, JSON.stringify({ notes: { token: ROTATED } }), { mode: 0o600 });
    expect((await f.run(["refresh", "notes", "--allow-start"])).code).toBe(0);
    expect(toolsOf(f)!.selections.map((s) => s.toolName)).toEqual(["lookup"]);
    expect(f.logLines().filter((l) => l.pid).at(-1)!.env!.NOTES_API).toBe(ROTATED);
  });
});

describe("agent status", () => {
  it("reports drift, binding problems and drop reasons", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read", "--required"]);
    let s = await f.status();
    let c = s.connections[0]!;
    expect(c).toMatchObject({ id: "notes", commandDrift: "same", available: true, selected: [{ tool: "lookup", required: true, compatibility: "ok" }] });
    expect(c.unavailableReason).toBeUndefined();
    expect(c.env.map((e) => [e.name, e.kind, e.status])).toEqual([
      ["NOTES_TOKEN", "binding", "ok"],
      ["NOTES_API", "binding", "ok"],
      ["LANG", "binding", "ok"],
    ]);

    // The binary behind the reviewed path changed: unavailable, selections need review, enable refuses.
    writeWrapper(f.wrapper, f.modeFile, f.log, "# upgraded\n");
    c = (await f.status()).connections[0]!;
    expect(c).toMatchObject({ commandDrift: "changed", available: false, unavailableReason: "binary_changed", selected: [{ tool: "lookup", compatibility: "needs_review" }] });
    let text = await f.run(["status"]);
    expect(text.out).toContain("UNAVAILABLE: binary_changed");
    expect(text.out).toContain("CHANGED since inspection");
    expect(text.out).toContain("lookup  required  needs_review");
    expect((await f.run(["enable", "notes", "peek", "--unattended-read"])).code).toBe(1);

    // A refresh records the new binary and keeps the selection (same command, argv, cwd, env).
    expect((await f.run(["refresh", "notes", "--allow-start"])).code).toBe(0);
    c = (await f.status()).connections[0]!;
    expect(c).toMatchObject({ commandDrift: "same", available: true, selected: [{ tool: "lookup", compatibility: "ok" }] });

    // A binding file that is no longer private: unavailable, reported on the env source.
    chmodSync(f.config, 0o644);
    s = await f.status();
    c = s.connections[0]!;
    expect(c.available).toBe(false);
    expect(c.unavailableReason).toBeUndefined();
    expect(c.env.find((e) => e.name === "NOTES_API")?.status).toBe("file_not_private");
    expect(c.selected[0]?.compatibility).toBe("connection_unavailable");
    expect((await f.run(["status"])).out).toContain("UNAVAILABLE");

    // The binary is gone.
    rmSync(f.wrapper);
    c = (await f.status()).connections[0]!;
    expect(c).toMatchObject({ commandDrift: "missing", available: false, unavailableReason: "binary_missing", selected: [{ tool: "lookup", compatibility: "needs_review" }] });
    text = await f.run(["status"]);
    expect(text.out).toContain("UNAVAILABLE: binary_missing");
    expect(text.out).toContain("MISSING");
  });

  it("works without a profile, and while the profile is locked", async () => {
    const f = fixture();
    rmSync(agentProfilePath(f.home));
    expect((await f.run(["status"])).code).toBe(0);
    writeFileSync(join(f.home, AGENT_PROFILE_LOCK_FILE), JSON.stringify({ pid: process.pid, instanceId: "core", startedAt: 0 }), { mode: 0o600 });
    expect((await f.run(["status", "--json"])).code).toBe(0);
  });
});

describe("the profile lock", () => {
  it("refuses every write with exit 2 while another live process holds it", async () => {
    const f = fixture();
    await f.run(["inspect", f.def, "--allow-start"]);
    const before = profileText(f);
    writeFileSync(join(f.home, AGENT_PROFILE_LOCK_FILE), JSON.stringify({ pid: process.pid, instanceId: "core", startedAt: 0 }), { mode: 0o600 });
    expect((await f.run(["inspect", f.def, "--allow-start"])).code).toBe(2);
    expect((await f.run(["enable", "notes", "lookup", "--unattended-read"])).code).toBe(2);
    expect((await f.run(["disable", "notes", "lookup"])).code).toBe(2);
    expect((await f.run(["refresh", "notes", "--allow-start"])).code).toBe(2);
    expect(profileText(f)).toBe(before);
    expect(existsSync(join(f.home, AGENT_PROFILE_LOCK_FILE))).toBe(true);
  });
});

describe("secrets", () => {
  it("never appear in any output or in the written profile", async () => {
    const f = fixture();
    await f.run(["inspect", f.def]);
    await f.run(["inspect", f.def, "--allow-start"]);
    await f.run(["enable", "notes", "lookup", "--unattended-read", "--required"]);
    await f.run(["status"]);
    await f.run(["status", "--json"]);
    writeFileSync(f.modeFile, "schema-change");
    await f.run(["refresh", "notes", "--allow-start"]);
    // Failure paths: a readable definition with a literal off the allowlist, and a bad pointer.
    chmodSync(f.def, 0o644);
    await f.run(["inspect", f.def, "--allow-start"]);
    chmodSync(f.def, 0o600);
    writeFileSync(f.config, JSON.stringify({ other: CFG_SECRET }), { mode: 0o600 });
    await f.run(["refresh", "notes", "--allow-start"]);
    await f.run(["status"]);
    // The auth-prompt path, on a known connection and on a new one, after the values resolved.
    writeFileSync(f.config, JSON.stringify({ notes: { token: CFG_SECRET } }), { mode: 0o600 });
    writeFileSync(f.modeFile, "elicit-init");
    const prompted = f.logLines().length;
    expect((await f.run(["refresh", "notes", "--allow-start"])).code).toBe(1);
    f.writeDef({ id: "notes-two", command: f.wrapper, args: ["--stdio"], env: { NOTES_TOKEN: DEF_SECRET, NOTES_API: { file: f.config, pointer: "/notes/token" } } });
    expect((await f.run(["inspect", f.def, "--allow-start"])).code).toBe(1);
    await f.run(["status"]);
    await f.run(["status", "--json"]);
    expect(f.logLines().slice(prompted).filter((l) => l.env?.NOTES_TOKEN === DEF_SECRET && l.env?.NOTES_API === CFG_SECRET)).toHaveLength(2);
    expect(toolsOf(f)!.connections.map((c) => [c.id, c.unavailable?.reason])).toEqual([["notes", "auth_prompt"]]);

    // The backend did receive both values, so they were resolved.
    expect(f.logLines().some((l) => l.env?.NOTES_TOKEN === DEF_SECRET && l.env?.NOTES_API === CFG_SECRET)).toBe(true);
    const everything = [...f.outputs, profileText(f)].join("\n");
    expect(everything).not.toContain(DEF_SECRET);
    expect(everything).not.toContain(CFG_SECRET);
  });
});
