// The definition file's validation, the command drift record, and how listed tools become
// inspected-only records. The live inspection is covered end to end in profileCli.test.ts;
// here only its auth-prompt rule, against fake-backend.mjs.

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandDrift, inspectBackend, loadBackendDefinition, resolveCommand, toInspectedTool } from "./backendDefinition.js";
import { FAKE_BACKEND, LOOKUP_SCHEMA, type BackendLogLine } from "./testing/fakeBackend.js";
import { MAX_DESCRIPTION_CHARS, schemaHash } from "./toolProfile.js";

const SECRET = "SENTINEL-DEFINITION-91ab";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scout-def-")));
  dirs.push(d);
  return d;
}
function def(d: string, body: unknown, mode = 0o600): string {
  const p = join(d, "def.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  chmodSync(p, mode);
  return p;
}
const base = { id: "notes", command: process.execPath, args: ["--stdio"] };

describe("loadBackendDefinition", () => {
  it("keeps literal values in a 0600 definition file as bindings to it, never in the connection", () => {
    const d = dir();
    const p = def(d, { ...base, env: { NOTES_TOKEN: SECRET, LANG: "C", CFG_KEY: { file: "/abs/cfg.json", pointer: "/k" } }, cwd: d });
    const r = loadBackendDefinition(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.connection).toEqual({
      id: "notes",
      transport: "stdio",
      command: process.execPath,
      args: ["--stdio"],
      env: { NOTES_TOKEN: { file: p, pointer: "/env/NOTES_TOKEN" }, LANG: { file: p, pointer: "/env/LANG" }, CFG_KEY: { file: "/abs/cfg.json", pointer: "/k" } },
      cwd: d,
    });
    expect(r.definition.resolvedCommand.path).toBe(realpathSync(process.execPath));
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("copies allowlisted literals of a readable file into literalEnv", () => {
    const d = dir();
    const env = { LANG: "C", LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin", HOME: "/Users/u", XDG_CONFIG_HOME: "/Users/u/.config", NO_COLOR: "1", PYTHONUNBUFFERED: "1" };
    const ok = loadBackendDefinition(def(d, { ...base, env }, 0o644));
    expect(ok.ok && ok.definition.connection).toMatchObject({ env: {}, literalEnv: env });
  });

  it.each(["API_TOKEN", "DATABASE_URL", "NOTES_ENDPOINT", "lang", "LC_"])("refuses the literal %s in a readable file, asking for chmod 600, without quoting it", (name) => {
    const bad = loadBackendDefinition(def(dir(), { ...base, env: { LANG: "C", [name]: SECRET } }, 0o644));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join("\n")).toContain(`env.${name}`);
    expect(!bad.ok && bad.errors.join("\n")).toContain("chmod 600");
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it.each([0o620, 0o602, 0o660, 0o666])("refuses a definition file writable by group or others (mode %o)", (mode) => {
    const r = loadBackendDefinition(def(dir(), { ...base, env: { LANG: "C" } }, mode));
    expect(r).toEqual({ ok: false, errors: ["definition: writable by group or others (chmod go-w it, or chmod 600 it)"] });
  });

  it.each<[string, Record<string, unknown>]>([
    ["NODE_OPTIONS", { NODE_OPTIONS: "--require /x.js" }],
    ["DYLD_INSERT_LIBRARIES", { DYLD_INSERT_LIBRARIES: "/x.dylib" }],
    ["LD_PRELOAD", { LD_PRELOAD: "/x.so" }],
    ["PYTHONPATH", { PYTHONPATH: { file: "/abs/c.json", pointer: "/p" } }],
  ])("refuses the process-injection name %s", (name, env) => {
    const r = loadBackendDefinition(def(dir(), { ...base, env }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toContain(name);
  });

  it.each<[string, unknown]>([
    ["a relative command", { ...base, command: "node" }],
    ["a missing command", { ...base, command: "/nonexistent/scout-backend" }],
    ["an unknown field", { ...base, shell: true }],
    ["a bad id", { ...base, id: "Notes!" }],
    ["a relative binding file", { ...base, env: { A: { file: "cfg.json", pointer: "/a" } } }],
    ["a bad pointer", { ...base, env: { A: { file: "/abs/cfg.json", pointer: "a" } } }],
    ["a cwd that is not a directory", { ...base, cwd: "/nonexistent/dir" }],
    ["not JSON", `{"id": "notes", "env": {"T": "${SECRET}"`],
  ])("refuses %s, without quoting values", (_, body) => {
    const r = loadBackendDefinition(def(dir(), body));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("refuses a definition owned by someone else, a symlink, and a relative path", () => {
    const d = dir();
    const p = def(d, base);
    expect(loadBackendDefinition(p, { getuid: () => (process.getuid?.() ?? 0) + 1 }).ok).toBe(false);
    symlinkSync(p, join(d, "link.json"));
    expect(loadBackendDefinition(join(d, "link.json")).ok).toBe(false);
    expect(loadBackendDefinition("def.json").ok).toBe(false);
  });
});

describe("command drift", () => {
  it("is same, changed after the binary is replaced, and missing once it is gone", () => {
    const d = dir();
    const exe = join(d, "backend");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    const recorded = resolveCommand(exe)!;
    expect(commandDrift(exe, recorded)).toBe("same");
    writeFileSync(exe, "#!/bin/sh\n# replaced\nexit 0\n");
    expect(commandDrift(exe, recorded)).toBe("changed");
    rmSync(exe);
    expect(commandDrift(exe, recorded)).toBe("missing");
  });
});

describe("toInspectedTool", () => {
  it("keeps a selectable tool's schema and hash", () => {
    expect(toInspectedTool({ name: "lookup", description: "Look up", inputSchema: LOOKUP_SCHEMA as never })).toEqual({
      tool: { name: "lookup", description: "Look up", inputSchema: LOOKUP_SCHEMA, schemaHash: schemaHash(LOOKUP_SCHEMA) },
      truncated: false,
    });
  });

  it("marks unusable names unselectable, strips control characters, truncates long descriptions, and skips unprintable names", () => {
    const odd = toInspectedTool({ name: "has.dot", description: "a\u001b[31mred\u0007", inputSchema: { type: "object" } });
    expect(odd?.tool).toEqual({ name: "has.dot", description: "a[31mred", unselectable: "name_not_supported" });
    const long = toInspectedTool({ name: "t", description: "x".repeat(MAX_DESCRIPTION_CHARS + 5), inputSchema: { type: "object" } });
    expect(long?.truncated).toBe(true);
    expect(long?.tool.description).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(toInspectedTool({ name: "bad\u001bname", inputSchema: { type: "object" } })).toBeUndefined();
  });
});

describe("inspectBackend", () => {
  const limits = { startupMs: 5000, overallMs: 10_000, stopGraceMs: 2000 };
  const run = async (mode: string) => {
    const log = join(dir(), "backend.log");
    const outcome = await inspectBackend({ command: process.execPath, args: [FAKE_BACKEND, "--mode", mode, "--log", log] }, {}, limits);
    const lines = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as BackendLogLine)
      : [];
    return { outcome, lines };
  };

  it("lists the tools of a backend that asks for nothing", async () => {
    const { outcome } = await run("honest");
    expect(outcome.ok && outcome.tools.map((t) => t.name)).toEqual(["lookup", "secret_tool", "peek"]);
  });

  it("fails with auth_prompt, returning no tools, when the backend asks for input during initialize or tools/list", async () => {
    for (const mode of ["elicit-init", "sample-list"]) {
      const { outcome, lines } = await run(mode);
      expect(outcome).toEqual({ ok: false, reason: "auth_prompt" });
      const pid = lines[0]!.pid!;
      expect(() => process.kill(pid, 0)).toThrow();
      if (mode === "elicit-init") expect(lines.some((l) => l.method === "tools/list")).toBe(false);
    }
  });
});
