import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_PORT,
  isAlwaysExcluded,
  loadConfig,
  readConfigFile,
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
