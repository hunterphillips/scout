import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkReadable,
  ConfigError,
  DEFAULT_PORT,
  isAlwaysExcluded,
  loadConfig,
  parseConfigFile,
  readConfigFile,
  resolveConfig,
  resolveHome,
  sourceGrantRevision,
  writeConfig,
  type PcmConfig,
} from "./config.js";

const dirs: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "pcm-config-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeRaw(home: string, value: unknown): void {
  writeFileSync(join(home, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConfigError ? e.code : "not-a-ConfigError";
  }
  return undefined;
}

const ENV = { HOME: "/Users/tester" };

describe("resolveHome", () => {
  it("honors PERSONAL_CONTEXT_HOME, else ~/.personal-context-mcp", () => {
    expect(resolveHome({ PERSONAL_CONTEXT_HOME: "/x" })).toBe("/x");
    expect(resolveHome({ HOME: "/Users/tester" })).toBe("/Users/tester/.personal-context-mcp");
  });

  it("refuses a relative PERSONAL_CONTEXT_HOME with a fixed code", () => {
    expect(codeOf(() => resolveHome({ PERSONAL_CONTEXT_HOME: "rel/pcm", HOME: "/Users/tester" }))).toBe("config-relative-home");
  });
});

describe("loading", () => {
  it("returns defaults with every source disabled when the file is missing", () => {
    const cfg = loadConfig(tempHome(), ENV);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.model).toBeNull();
    expect(cfg.maxRankMs).toBe(26_000);
    expect(cfg.sources.map((s) => s.id)).toEqual(["second-brain-notes", "project-thoughts", "focus"]);
    expect(cfg.sources.every((s) => !s.enabled)).toBe(true);
    expect(cfg).not.toHaveProperty("claudePath");
  });

  it("accepts a file holding only what setup merges, keeping the marker", () => {
    const home = tempHome();
    writeRaw(home, { x_scout_marker: "m-1", nodePath: "/usr/local/bin/node", claudePath: "/usr/local/bin/claude" });
    const file = readConfigFile(home);
    expect(file.x_scout_marker).toBe("m-1");
    const cfg = loadConfig(home, ENV);
    expect(cfg.claudePath).toBe("/usr/local/bin/claude");
    expect(cfg.nodePath).toBe("/usr/local/bin/node");
    expect(cfg.sources).toHaveLength(3);
  });

  it("expands ~ in markdown roots and registries", () => {
    const cfg = loadConfig(tempHome(), ENV);
    const byId = Object.fromEntries(cfg.sources.map((s) => [s.id, s]));
    expect(byId["second-brain-notes"]).toMatchObject({ root: "/Users/tester/workspace/second-brain/notes" });
    expect(byId["project-thoughts"]).toMatchObject({ registry: "/Users/tester/workspace/second-brain/notes", subpath: "thoughts/shared" });
  });

  it("accepts a task_recall markdown source and a model name", () => {
    const home = tempHome();
    writeRaw(home, {
      model: "opus",
      sources: [{ id: "saved", kind: "markdown_dir", enabled: true, root: "/tmp/saved", purpose: "task_recall" }],
    });
    const cfg = loadConfig(home, ENV);
    expect(cfg.model).toBe("opus");
    expect(cfg.sources[0]).toMatchObject({ purpose: "task_recall", exclude: [] });
  });

  it.each([
    ["not JSON", "{ nope SECRET-VALUE-1"],
    ["an array", "[1]"],
    ["null", "null"],
  ])("rejects a file that is %s with config-malformed and no content", (_label, text) => {
    const home = tempHome();
    writeRaw(home, text);
    let err: unknown;
    try {
      loadConfig(home, ENV);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe("config-malformed");
    expect((err as Error).message).not.toContain("SECRET-VALUE-1");
    expect((err as Error).message).not.toContain(home);
  });

  it.each([
    ["port", { port: "47821" }],
    ["port", { port: 70_000 }],
    ["model", { model: "--dangerously-skip-permissions" }],
    ["maxRankMs", { maxRankMs: 60_000 }],
    ["claudePath", { claudePath: "claude" }],
    ["sources", { sources: [{ id: "x", kind: "shell", enabled: true }] }],
    ["sources", { sources: [{ id: "x", kind: "markdown_dir", enabled: "yes", root: "/a" }] }],
    ["sources", { sources: [{ id: "x", kind: "markdown_dir", enabled: true, root: "/a", purpose: "priorities" }] }],
    ["sources", { sources: [{ id: "f", kind: "focus_http", enabled: true, url: "file:///etc/passwd" }] }],
  ])("rejects an invalid %s field, naming only the field", (field, value) => {
    const home = tempHome();
    writeRaw(home, value);
    let err: unknown;
    try {
      loadConfig(home, ENV);
    } catch (e) {
      err = e;
    }
    expect((err as ConfigError).code).toBe("config-invalid");
    expect((err as ConfigError).field).toBe(field);
  });

  it("rejects duplicate source ids and relative roots", () => {
    const home = tempHome();
    const src = { id: "a", kind: "markdown_dir", enabled: false, root: "/a" };
    writeRaw(home, { sources: [src, src] });
    expect(codeOf(() => loadConfig(home, ENV))).toBe("config-duplicate-source-id");
    writeRaw(home, { sources: [{ ...src, root: "notes" }] });
    expect(codeOf(() => loadConfig(home, ENV))).toBe("config-relative-source-path");
  });

  it("reports an unreadable file as config-unreadable", () => {
    const home = tempHome();
    writeRaw(home, {});
    chmodSync(join(home, "config.json"), 0o000);
    expect(codeOf(() => loadConfig(home, ENV))).toBe("config-unreadable");
  });
});

describe("writeConfig", () => {
  it("writes atomically as 0600, preserving unknown keys and unexpanded paths", () => {
    const home = join(tempHome(), "pcm");
    const file = readConfigFile(home);
    file.x_scout_marker = "m-2";
    file.sources[0]!.enabled = true;
    writeConfig(home, file);
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readdirSync(home)).toEqual(["config.json"]);
    const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(onDisk.x_scout_marker).toBe("m-2");
    expect(onDisk.sources[0]).toMatchObject({ enabled: true, root: "~/workspace/second-brain/notes" });
    expect(readConfigFile(home)).toEqual(file);
  });

  it("refuses to write an invalid config and leaves the old file alone", () => {
    const home = tempHome();
    writeRaw(home, { port: 1234 });
    const file = readConfigFile(home);
    expect(codeOf(() => writeConfig(home, { ...file, port: -1 }))).toBe("config-invalid");
    expect(readConfigFile(home).port).toBe(1234);
  });
});

describe("sourceGrantRevision", () => {
  const base = (): PcmConfig => loadConfig(tempHome(), ENV);

  it("is 16 hex chars and ignores disabled sources, port, model and order", () => {
    const a = base();
    const rev = sourceGrantRevision(a);
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    const b = { ...a, port: 1, model: "opus", sources: [...a.sources].reverse() };
    expect(sourceGrantRevision(b)).toBe(rev);
    const c = { ...a, sources: a.sources.map((s) => (s.kind === "markdown_dir" ? { ...s, root: "/elsewhere" } : s)) };
    expect(sourceGrantRevision(c)).toBe(rev); // still disabled
  });

  it("changes when a source is enabled, a project is enabled, or an enabled root moves", () => {
    const a = base();
    const r0 = sourceGrantRevision(a);
    const enabled = { ...a, sources: a.sources.map((s) => ({ ...s, enabled: true })) };
    const r1 = sourceGrantRevision(enabled);
    expect(r1).not.toBe(r0);
    const withProject = {
      ...enabled,
      sources: enabled.sources.map((s) => (s.kind === "registry_projects" ? { ...s, enabledProjects: ["scout"] } : s)),
    };
    expect(sourceGrantRevision(withProject)).not.toBe(r1);
    const moved = { ...enabled, sources: enabled.sources.map((s) => (s.kind === "markdown_dir" ? { ...s, root: "/elsewhere" } : s)) };
    expect(sourceGrantRevision(moved)).not.toBe(r1);
    const recall = { ...enabled, sources: enabled.sources.map((s) => (s.kind === "markdown_dir" ? { ...s, purpose: "task_recall" as const } : s)) };
    expect(sourceGrantRevision(recall)).not.toBe(r1);
  });
});

describe("isAlwaysExcluded", () => {
  const opts = { home: "/Users/tester" };
  const root = "/data/notes";

  it.each([
    "/data/notes/.git/config",
    "/data/notes/sub/node_modules/x/readme.md",
    "/data/notes/.env",
    "/data/notes/app/.env.local",
    "/data/notes/certs/server.pem",
    "/data/notes/id.key",
    "/data/notes/my-Secrets/list.md",
    "/data/notes/api_token.md",
    "/data/notes/credentials.md",
  ])("excludes %s", (p) => {
    expect(isAlwaysExcluded(p, root, opts)).toBe(true);
  });

  it.each(["/data/notes/billing.md", "/data/notes/projects/scout/plan.md", "/data/notes/inbox/today.md", "/data/notes/keys.md"])(
    "allows %s",
    (p) => {
      expect(isAlwaysExcluded(p, root, opts)).toBe(false);
    },
  );

  it("excludes paths outside the source root", () => {
    expect(isAlwaysExcluded("/data/other.md", root, opts)).toBe(true);
    expect(isAlwaysExcluded("/data/notes/../x.md", root, opts)).toBe(true);
    expect(isAlwaysExcluded("/data/notes", root, opts)).toBe(false);
  });

  it("excludes inbox/ and log/ directly under a second-brain root only", () => {
    for (const sb of ["/Users/tester/workspace/second-brain", "/Users/tester/workspace/second-brain/notes"]) {
      expect(isAlwaysExcluded(`${sb}/inbox/idea.md`, sb, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/log/2026-09-30.md`, sb, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/topics/log/x.md`, sb, opts)).toBe(false);
    }
  });

  it("excludes ~/workspace/second-brain/inbox and log by absolute path whatever the root", () => {
    const sb = "/Users/tester/workspace/second-brain";
    for (const r of ["/Users/tester/workspace", "/Users/tester"]) {
      expect(isAlwaysExcluded(`${sb}/inbox/x.md`, r, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/log/y.md`, r, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/inbox`, r, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/log`, r, opts)).toBe(true);
      expect(isAlwaysExcluded(`${sb}/notes/idea.md`, r, opts)).toBe(false);
      expect(isAlwaysExcluded(`${sb}/inbox-archive/x.md`, r, opts)).toBe(false);
    }
  });

  it("allows notes/inbox-ideas.md under a second-brain root (a file named like inbox is not the inbox folder)", () => {
    const sb = "/Users/tester/workspace/second-brain";
    expect(isAlwaysExcluded(`${sb}/notes/inbox-ideas.md`, sb, opts)).toBe(false);
    expect(isAlwaysExcluded(`${sb}/notes/inbox-ideas.md`, "/Users/tester/workspace", opts)).toBe(false);
  });

  it("excludes everything under ~/workspace/personal-context", () => {
    const pc = "/Users/tester/workspace/personal-context";
    expect(isAlwaysExcluded(`${pc}/profile.md`, "/Users/tester/workspace", opts)).toBe(true);
    expect(isAlwaysExcluded(`${pc}/profile.md`, pc, opts)).toBe(true);
    expect(isAlwaysExcluded("/Users/tester/workspace/personal-context-other/a.md", "/Users/tester/workspace", opts)).toBe(false);
  });
});

describe("prototype keys", () => {
  const PROTO = '{"__proto__":{"claudePath":"relative/claude"},"constructor":{"x":1},"prototype":1,"sources":[{"id":"a","kind":"markdown_dir","enabled":false,"root":"/data/a","__proto__":{"purpose":"priorities"}}]}';

  it("drops __proto__, constructor and prototype at every depth", () => {
    const file = parseConfigFile(JSON.parse(PROTO));
    expect(file.claudePath).toBeUndefined();
    expect(Object.getPrototypeOf(file)).toBe(Object.prototype);
    expect(Object.hasOwn(file, "constructor")).toBe(false);
    expect(Object.hasOwn(file, "prototype")).toBe(false);
    expect(file.sources[0]).not.toHaveProperty("purpose");
    expect(Object.getPrototypeOf(file.sources[0])).toBe(Object.prototype);
    expect(resolveConfig(file, ENV).claudePath).toBeUndefined();
  });

  it("does not expose or write back the key when read from disk", () => {
    const home = tempHome();
    writeRaw(home, PROTO);
    const file = readConfigFile(home);
    expect(loadConfig(home, ENV).claudePath).toBeUndefined();
    writeConfig(home, file, ENV);
    const text = readFileSync(join(home, "config.json"), "utf8");
    expect(text).not.toContain("__proto__");
    expect(text).not.toContain("relative/claude");
    expect(text).not.toContain('"constructor"');
  });

  it("rejects absurdly deep nesting as malformed", () => {
    const home = tempHome();
    writeRaw(home, `{"x":${"[".repeat(200)}${"]".repeat(200)}}`);
    expect(codeOf(() => readConfigFile(home))).toBe("config-malformed");
  });
});

describe("config file and home safety", () => {
  it("refuses a config file over 1 MiB", () => {
    const home = tempHome();
    writeRaw(home, `{"x":"${"a".repeat(1024 * 1024)}"}`);
    expect(codeOf(() => readConfigFile(home))).toBe("config-too-large");
  });

  it("refuses a symlinked config file", () => {
    const home = tempHome();
    const elsewhere = tempHome();
    writeRaw(elsewhere, { port: 1234 });
    symlinkSync(join(elsewhere, "config.json"), join(home, "config.json"));
    expect(codeOf(() => readConfigFile(home))).toBe("config-unreadable");
  });

  it("refuses a symlinked home for read and write", () => {
    const real = tempHome();
    const link = join(tempHome(), "pcm-link");
    symlinkSync(real, link);
    expect(codeOf(() => readConfigFile(link))).toBe("config-home-symlink");
    expect(codeOf(() => writeConfig(link, readConfigFile(real), ENV))).toBe("config-home-symlink");
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a 0755 home and leaves its mode unchanged", () => {
    const home = tempHome();
    chmodSync(home, 0o755);
    expect(codeOf(() => readConfigFile(home))).toBe("config-home-not-private");
    expect(codeOf(() => writeConfig(home, parseConfigFile({}), ENV))).toBe("config-home-not-private");
    expect(statSync(home).mode & 0o777).toBe(0o755);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a home that is a file, or not owned by us", () => {
    const parent = tempHome();
    const file = join(parent, "pcm");
    writeFileSync(file, "x");
    expect(codeOf(() => readConfigFile(file))).toBe("config-home-not-directory");
    const home = tempHome();
    expect(codeOf(() => readConfigFile(home, 999_999))).toBe("config-home-wrong-owner");
    expect(codeOf(() => writeConfig(home, parseConfigFile({}), ENV, 999_999))).toBe("config-home-wrong-owner");
  });

  it("never saves a config loadConfig would reject", () => {
    const home = tempHome();
    const file = parseConfigFile({ sources: [{ id: "a", kind: "markdown_dir", enabled: false, root: "~" }] });
    expect(codeOf(() => writeConfig(home, file, ENV))).toBe("config-source-root-too-broad");
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("grant shapes", () => {
  const md = (extra: Record<string, unknown>) => ({ sources: [{ id: "a", kind: "markdown_dir", enabled: false, root: "/data/a", ...extra }] });
  const reg = (extra: Record<string, unknown>) => ({
    sources: [{ id: "p", kind: "registry_projects", enabled: false, registry: "/data/reg", subpath: "thoughts/shared", ...extra }],
  });
  const focus = (url: string) => ({ sources: [{ id: "f", kind: "focus_http", enabled: false, url }] });

  it.each([
    ["absolute subpath", reg({ subpath: "/etc" })],
    ["subpath with ..", reg({ subpath: "thoughts/../../.." })],
    ["subpath that is ..", reg({ subpath: ".." })],
    ["subpath that is .", reg({ subpath: "." })],
    ["subpath starting ./", reg({ subpath: "./thoughts" })],
    ["subpath with an empty segment", reg({ subpath: "thoughts//shared" })],
    ["project with a slash", reg({ enabledProjects: ["a/b"] })],
    ["project ..", reg({ enabledProjects: [".."] })],
    ["project .", reg({ enabledProjects: ["."] })],
    ["empty project", reg({ enabledProjects: [""] })],
    ["project with a space", reg({ enabledProjects: ["my project"] })],
    ["remote focus url", focus("http://example.com:4242/api/focus")],
    ["https focus url", focus("https://127.0.0.1:4242/api/focus")],
    ["focus url without port", focus("http://127.0.0.1/api/focus")],
    ["focus url with credentials", focus("http://u:p@127.0.0.1:4242/api/focus")],
    ["focus url with userinfo trick", focus("http://127.0.0.1:4242@evil.example/api")],
    ["focus url on 0.0.0.0", focus("http://0.0.0.0:4242/api/focus")],
    ["uppercase id", md({ id: "Notes" })],
    ["id with a slash", md({ id: "a/b" })],
    ["id starting with -", md({ id: "-a" })],
    ["id over 64 chars", md({ id: "a".repeat(65) })],
  ])("rejects %s at parse time", (_label, value) => {
    expect(codeOf(() => parseConfigFile(value))).toBe("config-invalid");
  });

  it.each([
    reg({ subpath: "thoughts/shared", enabledProjects: ["scout", "rook-workspace", "a.b_c"] }),
    focus("http://127.0.0.1:4242/api/focus"),
    focus("http://localhost:4242/api/focus"),
    md({ id: "second-brain-notes" }),
  ])("accepts a safe grant %#", (value) => {
    expect(codeOf(() => parseConfigFile(value))).toBeUndefined();
  });

  it.each(["/", "~", "~/", "/Users", "/Users/tester", "/users/TESTER", "/Users/tester/../tester"])(
    "rejects a root or registry at %s (/, $HOME or an ancestor of it)",
    (root) => {
      expect(codeOf(() => resolveConfig(parseConfigFile(md({ root })), ENV))).toBe("config-source-root-too-broad");
      expect(codeOf(() => resolveConfig(parseConfigFile(reg({ registry: root })), ENV))).toBe("config-source-root-too-broad");
    },
  );

  it.each(["~/workspace/second-brain/notes", "/Users/tester/x", "/data/notes", "/Users/testers"])("accepts a root at %s", (root) => {
    expect(codeOf(() => resolveConfig(parseConfigFile(md({ root })), ENV))).toBeUndefined();
  });
});

describe("isAlwaysExcluded hardening", () => {
  const opts = { home: "/Users/tester" };

  it.each([
    ["INBOX", "/Users/tester/workspace/second-brain/INBOX/x.md", "/Users/tester/workspace"],
    ["Log", "/Users/tester/workspace/second-brain/Log/y.md", "/Users/tester/workspace"],
    ["Workspace capitalization", "/Users/tester/Workspace/personal-context/profile.md", "/Users/tester/Workspace"],
    ["Second-Brain capitalization", "/Users/tester/workspace/Second-Brain/inbox/x.md", "/Users/tester/workspace"],
    ["NFD spelling of a folded name", "/Users/tester/workspace/second-brain/INBOX/x.md".normalize("NFD"), "/Users/tester/workspace"],
    ["INBOX under a second-brain root elsewhere", "/data/second-brain/INBOX/a.md", "/data/second-brain"],
    ["service home", "/Users/tester/.personal-context-mcp/config.json", "/Users/tester/workspace/../"],
    ["service home, other case", "/Users/tester/.Personal-Context-MCP/config.json", "/Users/tester/x/.."],
  ])("excludes %s", (_label, p, root) => {
    expect(isAlwaysExcluded(p, root, opts)).toBe(true);
  });

  it.each([
    "/data/notes/.ssh/config",
    "/data/notes/.SSH/known_hosts",
    "/data/notes/.gnupg/pubring.kbx",
    "/data/notes/id_ed25519",
    "/data/notes/keys/ID_RSA.pub",
    "/data/notes/.netrc",
    "/data/notes/.npmrc",
    "/data/notes/cert.p12",
    "/data/notes/cert.PFX",
    "/data/notes/Library/Keychains/login.keychain-db",
    "/data/notes/.GIT/config",
    "/data/notes/Node_Modules/x.md",
  ])("excludes widened pattern %s", (p) => {
    expect(isAlwaysExcluded(p, "/data/notes", opts)).toBe(true);
  });

  it("allows id_ only as a directory name and ordinary files", () => {
    expect(isAlwaysExcluded("/data/notes/idea.md", "/data/notes", opts)).toBe(false);
    expect(isAlwaysExcluded("/data/notes/ids/list.md", "/data/notes", opts)).toBe(false);
  });

  it("excludes a root whose own last segment matches, including the root itself", () => {
    expect(isAlwaysExcluded("/data/secrets", "/data/secrets", opts)).toBe(true);
    expect(isAlwaysExcluded("/data/secrets/a.md", "/data/secrets", opts)).toBe(true);
    expect(isAlwaysExcluded("/data/.ssh", "/data/.ssh", opts)).toBe(true);
    expect(isAlwaysExcluded("/data/notes", "/data/notes", opts)).toBe(false);
  });

  it("honors a PERSONAL_CONTEXT_HOME-style service home", () => {
    expect(isAlwaysExcluded("/srv/pcm/config.json", "/srv", { ...opts, serviceHome: "/srv/pcm" })).toBe(true);
  });

  it("fails closed on non-absolute paths", () => {
    expect(isAlwaysExcluded("notes/a.md", "/data/notes", opts)).toBe(true);
    expect(isAlwaysExcluded("/data/notes/a.md", "notes", opts)).toBe(true);
    expect(isAlwaysExcluded("/data/notes/a.md", "/data/notes", { home: "tester" })).toBe(true);
  });
});

describe("checkReadable", () => {
  function tree() {
    const root = realpathSync(tempHome());
    const home = join(root, "home");
    const notes = join(home, "notes");
    mkdirSync(notes, { recursive: true });
    mkdirSync(join(home, "workspace", "personal-context"), { recursive: true });
    writeFileSync(join(notes, "a.md"), "a");
    writeFileSync(join(home, "workspace", "personal-context", "profile.md"), "p");
    return { root, home, notes };
  }

  it("returns the real path for a readable file", () => {
    const { home, notes } = tree();
    expect(checkReadable(join(notes, "a.md"), notes, { home })).toEqual({ ok: true, realPath: join(notes, "a.md") });
  });

  it("refuses non-absolute input", () => {
    const { home, notes } = tree();
    expect(checkReadable("a.md", notes, { home })).toEqual({ ok: false, code: "not-absolute" });
    expect(checkReadable(join(notes, "a.md"), "notes", { home })).toEqual({ ok: false, code: "not-absolute" });
  });

  it("fails closed on a missing file or any realpath error", () => {
    const { home, notes } = tree();
    expect(checkReadable(join(notes, "missing.md"), notes, { home })).toEqual({ ok: false, code: "unresolvable" });
    const realpath = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(checkReadable(join(notes, "a.md"), notes, { home, realpath })).toEqual({ ok: false, code: "unresolvable" });
  });

  it("refuses a symlink that escapes the root", () => {
    const { root, home, notes } = tree();
    writeFileSync(join(root, "outside.md"), "o");
    symlinkSync(join(root, "outside.md"), join(notes, "link.md"));
    expect(checkReadable(join(notes, "link.md"), notes, { home })).toEqual({ ok: false, code: "outside-root" });
  });

  it("refuses a symlink into the profile store even when the root contains it", () => {
    const { home } = tree();
    const ws = join(home, "workspace");
    symlinkSync(join(ws, "personal-context", "profile.md"), join(ws, "innocent.md"));
    expect(checkReadable(join(ws, "innocent.md"), ws, { home })).toEqual({ ok: false, code: "excluded" });
  });

  it("refuses the profile store reached through a symlinked workspace", () => {
    const { root, home } = tree();
    // ~/workspace is really <root>/real-ws; the lexical exclusion under ~/workspace can't see it.
    const realWs = join(root, "real-ws");
    mkdirSync(join(realWs, "personal-context"), { recursive: true });
    writeFileSync(join(realWs, "personal-context", "p.md"), "p");
    const home2 = join(root, "home2");
    mkdirSync(home2);
    symlinkSync(realWs, join(home2, "workspace"));
    expect(checkReadable(join(realWs, "personal-context", "p.md"), realWs, { home: home2 })).toEqual({ ok: false, code: "excluded" });
  });

  it("refuses a root that is really $HOME through a symlink", () => {
    const { root, home } = tree();
    const link = join(home, "notes-link");
    symlinkSync(home, link);
    writeFileSync(join(home, "top.md"), "t");
    expect(checkReadable(join(link, "top.md"), link, { home })).toEqual({ ok: false, code: "too-broad" });
    // An ancestor of $HOME through a symlink is refused the same way.
    const up = join(home, "up-link");
    symlinkSync(root, up);
    expect(checkReadable(join(up, "home", "top.md"), up, { home })).toEqual({ ok: false, code: "too-broad" });
  });

  it("refuses a lexically too-broad root", () => {
    const { home } = tree();
    writeFileSync(join(home, "top.md"), "t");
    expect(checkReadable(join(home, "top.md"), home, { home })).toEqual({ ok: false, code: "too-broad" });
  });

  it("refuses a case-variant spelling of an excluded directory", () => {
    const { home } = tree();
    const brain = join(home, "workspace", "second-brain");
    mkdirSync(join(brain, "inbox"), { recursive: true });
    writeFileSync(join(brain, "inbox", "x.md"), "x");
    // The fake realpath returns the spelling as given, as a case-insensitive disk would not.
    const realpath = (p: string) => p;
    expect(checkReadable(join(brain, "INBOX", "x.md"), brain, { home, realpath })).toEqual({ ok: false, code: "excluded" });
  });
});
