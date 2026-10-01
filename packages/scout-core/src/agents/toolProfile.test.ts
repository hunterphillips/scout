import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileSchema, DEFAULT_AGENT_MODEL, loadAgentProfile, profileFingerprint, writeAgentProfile, type AgentProfile } from "./profile.js";
import { EMPTY_SCHEMA, LOOKUP_SCHEMA, selection } from "./testing/fakeBackend.js";
import { BINDING_FILE_MAX_BYTES, BindingError, isAllowedEnvName, resolveEnvBindings, schemaHash, ToolsProfileSchema, type Connection, type ToolsProfile } from "./toolProfile.js";

const SECRET = "SENTINEL-BINDING-SECRET-3c4d";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "scout-tools-"));
  dirs.push(d);
  return d;
}

const conn = (patch: Partial<Connection> = {}): Connection => ({
  id: "notes",
  transport: "stdio",
  command: "/opt/notes/bin/notes-mcp",
  args: ["--stdio"],
  env: { NOTES_TOKEN: { file: "/Users/u/.config/notes/mcp.json", pointer: "/env/NOTES_TOKEN" } },
  ...patch,
});
const tools = (patch: Partial<ToolsProfile> = {}): ToolsProfile => ({ connections: [conn()], selections: [selection("notes", "lookup", true)], ...patch });
const base: AgentProfile = { schemaVersion: 1, adapter: "claude-code", claudePath: "/opt/bin/claude", model: DEFAULT_AGENT_MODEL };

describe("selected tools in the agent profile", () => {
  it("accepts a reviewed definition and selection, and stores bindings, not values", () => {
    expect(ToolsProfileSchema.safeParse(tools()).success).toBe(true);
    expect(AgentProfileSchema.safeParse({ ...base, tools: tools() }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a relative command", tools({ connections: [conn({ command: "notes-mcp" })] })],
    ["an http transport", tools({ connections: [{ ...conn(), transport: "http" } as unknown as Connection] })],
    ["a NODE_OPTIONS binding", tools({ connections: [conn({ env: { NODE_OPTIONS: { file: "/a.json", pointer: "/x" } } })] })],
    ["a DYLD_ binding", tools({ connections: [conn({ env: { DYLD_INSERT_LIBRARIES: { file: "/a.json", pointer: "/x" } } })] })],
    ["an LD_ binding", tools({ connections: [conn({ env: { LD_PRELOAD: { file: "/a.json", pointer: "/x" } } })] })],
    ["a literal env value instead of a binding", tools({ connections: [{ ...conn(), env: { NOTES_TOKEN: SECRET } } as unknown as Connection] })],
    ["a relative binding file", tools({ connections: [conn({ env: { NOTES_TOKEN: { file: "mcp.json", pointer: "/x" } } })] })],
    ["a pointer that is not RFC 6901", tools({ connections: [conn({ env: { NOTES_TOKEN: { file: "/a.json", pointer: "env.x" } } })] })],
    ["a schema hash that does not match", tools({ selections: [{ ...selection("notes", "lookup", true), schemaHash: schemaHash(EMPTY_SCHEMA) }] })],
    ["no unattended-use declaration", tools({ selections: [{ ...selection("notes", "lookup", true), unattendedReadDeclared: false as true }] })],
    ["a selection on an unknown connection", tools({ selections: [selection("other", "lookup", true)] })],
    ["the same tool name twice", tools({ connections: [conn(), conn({ id: "notes2" })], selections: [selection("notes", "lookup", true), selection("notes2", "lookup", false)] })],
    ["a duplicate connection id", tools({ connections: [conn(), conn()] })],
    ["an unknown field", { ...tools(), extra: 1 }],
  ])("refuses %s", (_label, t) => {
    expect(ToolsProfileSchema.safeParse(t).success).toBe(false);
  });

  it("refuses process-injection names and keeps ordinary ones", () => {
    for (const n of ["NODE_OPTIONS", "node_options", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONPATH", "BASH_ENV", "BASH_FUNC_x%%", "JAVA_TOOL_OPTIONS", "1BAD", "A=B"]) expect(isAllowedEnvName(n)).toBe(false);
    for (const n of ["NOTES_TOKEN", "HOME", "PATH", "LANG", "GITHUB_TOKEN"]) expect(isAllowedEnvName(n)).toBe(true);
  });

  it("the fingerprint changes when a selection, its schema or required flag, or a definition changes", () => {
    const fp = (t?: ToolsProfile) => profileFingerprint(t ? { ...base, tools: t } : base);
    const all = [
      fp(),
      fp(tools()),
      fp(tools({ selections: [selection("notes", "lookup", false)] })),
      fp(tools({ selections: [selection("notes", "lookup", true, { ...LOOKUP_SCHEMA, properties: { query: { type: "string" }, n: { type: "number" } } })] })),
      fp(tools({ connections: [conn({ args: ["--stdio", "--verbose"] })] })),
      fp(tools({ connections: [conn({ env: { NOTES_TOKEN: { file: "/Users/u/.config/notes/mcp.json", pointer: "/env/OTHER" } } })] })),
    ];
    expect(new Set(all).size).toBe(all.length);
    // Key order does not matter.
    const reordered = JSON.parse(JSON.stringify({ tools: tools(), model: base.model, claudePath: base.claudePath, adapter: base.adapter, schemaVersion: 1 })) as AgentProfile;
    expect(profileFingerprint(reordered)).toBe(fp(tools()));
  });

  it("round-trips through agent-profile.json without any secret value", () => {
    const h = dir();
    const profile = { ...base, tools: tools() };
    writeAgentProfile(h, profile);
    expect(loadAgentProfile(h)).toEqual(profile);
  });
});

describe("resolveEnvBindings", () => {
  function file(content: unknown, mode = 0o600): string {
    const p = join(dir(), "config.json");
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), { mode });
    chmodSync(p, mode);
    return p;
  }
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(BindingError);
      expect(String((e as Error).message)).not.toContain(SECRET);
      expect(String((e as Error).message)).not.toContain(tmpdir());
      return (e as BindingError).code;
    }
    return undefined;
  };

  it("reads each bound value in memory from a private owned file, by pointer", () => {
    const p = file({ mcpServers: { notes: { env: { TOKEN: SECRET, "a/b": "slash", "t~": "tilde" } } } });
    expect(
      resolveEnvBindings({
        NOTES_TOKEN: { file: p, pointer: "/mcpServers/notes/env/TOKEN" },
        SLASH: { file: p, pointer: "/mcpServers/notes/env/a~1b" },
        TILDE: { file: p, pointer: "/mcpServers/notes/env/t~0" },
      }),
    ).toEqual({ NOTES_TOKEN: SECRET, SLASH: "slash", TILDE: "tilde" });
  });

  it.each<[string, () => { file: string; pointer: string }, string]>([
    ["a group/other-readable file", () => ({ file: file({ t: SECRET }, 0o644), pointer: "/t" }), "binding: file not a private regular file owned by this user"],
    ["a missing file", () => ({ file: join(dir(), "nope.json"), pointer: "/t" }), "binding: file missing"],
    ["a missing pointer", () => ({ file: file({ t: SECRET }), pointer: "/u" }), "binding: pointer not found"],
    ["a non-string value", () => ({ file: file({ t: { v: SECRET } }), pointer: "/t" }), "binding: value not a usable string"],
    ["a prototype key", () => ({ file: file({ t: SECRET }), pointer: "/constructor" }), "binding: pointer not found"],
    ["a file that is not JSON", () => ({ file: file(`{"t": "${SECRET}"`), pointer: "/t" }), "binding: file not JSON"],
    ["a file over 4 MiB", () => ({ file: file(JSON.stringify({ t: "x".repeat(BINDING_FILE_MAX_BYTES) })), pointer: "/t" }), "binding: file too large"],
    [
      "a symlink",
      () => {
        const target = file({ t: SECRET });
        const link = join(dir(), "link.json");
        symlinkSync(target, link);
        return { file: link, pointer: "/t" };
      },
      "binding: file unreadable",
    ],
  ])("refuses %s with a fixed code", (_label, binding, code) => {
    const b = binding();
    expect(codeOf(() => resolveEnvBindings({ NOTES_TOKEN: b }))).toBe(code);
  });

  it("refuses a file owned by another user", () => {
    const p = file({ t: SECRET });
    expect(codeOf(() => resolveEnvBindings({ NOTES_TOKEN: { file: p, pointer: "/t" } }, { getuid: () => 12345 }))).toBe("binding: file not a private regular file owned by this user");
  });

  it("refuses an injection name even if it got past the schema", () => {
    const p = file({ t: "--require /tmp/x.js" });
    expect(codeOf(() => resolveEnvBindings({ NODE_OPTIONS: { file: p, pointer: "/t" } }))).toBe("binding: name refused");
  });
});
