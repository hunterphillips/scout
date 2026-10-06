// The Codex readiness check against a scripted spawnSync (and once against a real script):
// no model, no network, no real codex; every path is under a temp dir.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexHome } from "./launch.js";
import { READINESS_INVOCATIONS, runCodexReadiness, runCodexReadinessFor, type SpawnSyncFn } from "./readiness.js";
import { createCodexReadinessFacade, readinessFingerprint } from "./readinessWorker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Box {
  base: string;
  scoutHome: string;
  userHome: string;
  authPath: string;
  codexPath: string;
  env: Record<string, string>;
}

function box(): Box {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "scr-")));
  dirs.push(base);
  chmodSync(base, 0o700);
  const scoutHome = join(base, "h");
  const userHome = join(base, "u");
  mkdirSync(scoutHome, { mode: 0o700 });
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  const authPath = join(userHome, ".codex", "auth.json");
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "placeholder" } }), { mode: 0o600 });
  const codexPath = join(base, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { base, scoutHome, userHome, authPath, codexPath, env: { HOME: userHome, PATH: "/usr/bin:/bin", LANG: "C", NODE_OPTIONS: "--inspect" } };
}

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

interface Call {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function scripted(o: { version?: string | null; login?: "chatgpt" | "api-key" | "none"; versionExit?: number; loginTimeout?: boolean } = {}): { spawnSync: SpawnSyncFn; calls: Call[] } {
  const calls: Call[] = [];
  const spawnSync: SpawnSyncFn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, env: { ...options.env } });
    expect(options).toMatchObject({ timeout: 20_000, killSignal: "SIGKILL" });
    const key = args.join(" ");
    if (key === "--version") {
      const v = o.version === undefined ? "0.155.1" : o.version;
      return { status: o.versionExit ?? 0, signal: null, stdout: v === null ? "" : `codex-cli ${v}\n`, stderr: "" };
    }
    if (key === "login status") {
      if (o.loginTimeout) return { status: null, signal: "SIGKILL", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      const login = o.login ?? "chatgpt";
      if (login === "chatgpt") return { status: 0, signal: null, stdout: "", stderr: "Logged in using ChatGPT\n" };
      if (login === "api-key") return { status: 0, signal: null, stdout: "", stderr: "Logged in using an API key - sk-proj-***ABCD\n" };
      return { status: 1, signal: null, stdout: "", stderr: "Not logged in\n" };
    }
    throw new Error(`unexpected invocation ${key}`);
  };
  return { spawnSync, calls };
}

function run(b: Box, s: { spawnSync: SpawnSyncFn }, env: Record<string, string> = b.env) {
  const home = ensureCodexHome(b.scoutHome, env);
  if (!home.ok) throw new Error(home.reason);
  return runCodexReadiness({ codexPath: b.codexPath, parentEnv: env, codexHome: home.codexHome, userAuthPath: home.userAuthPath, spawnSync: s.spawnSync });
}

describe("codex readiness: login states and version", () => {
  it("a ChatGPT login is subscription, with the CLI version; only the two allowlisted invocations ran, with the job's env", () => {
    const b = box();
    const s = scripted();
    expect(run(b, s)).toEqual({ verdict: "subscription", reasons: [], version: "0.155.1" });
    expect(s.calls.map((c) => c.args)).toEqual(READINESS_INVOCATIONS.map((a) => [...a]));
    for (const c of s.calls) {
      expect(c.command).toBe(b.codexPath);
      expect(Object.keys(c.env).sort()).toEqual(["CODEX_HOME", "CODEX_SQLITE_HOME", "HOME", "LANG", "PATH"]);
      expect(c.env.CODEX_HOME).toBe(join(b.scoutHome, "run", "codex-home"));
      expect(c.env.CODEX_SQLITE_HOME).toBe(c.cwd);
    }
    // The throwaway SQLite home is gone.
    expect(existsSync(s.calls[0]!.cwd)).toBe(false);
    expect(readdirSync(join(b.scoutHome, "run", "jobs"))).toEqual([]);
  });

  it.each<["api-key" | "none"]>([["api-key"], ["none"]])("a %s login is ambiguous: not_chatgpt", (login) => {
    const b = box();
    expect(run(b, scripted({ login }))).toEqual({ verdict: "ambiguous", reasons: ["not_chatgpt"], version: "0.155.1" });
  });

  it("a login check that times out is not_chatgpt", () => {
    const b = box();
    expect(run(b, scripted({ loginTimeout: true })).reasons).toEqual(["not_chatgpt"]);
  });

  it.each<[string | null, number, string | undefined]>([
    ["0.155.1", 0, "0.155.1"],
    ["1.0.12-alpha.3", 0, "1.0.12"],
    ["banana", 0, undefined],
    [null, 0, undefined],
    ["0.155.1", 2, undefined],
  ])("version %s (exit %i) parses to %s", (version, versionExit, expected) => {
    const b = box();
    const r = run(b, scripted({ version, versionExit }));
    expect(r.version).toBe(expected);
    if (expected === undefined) expect(r).toEqual({ verdict: "ambiguous", reasons: ["version_unknown"] });
    else expect(r.verdict).toBe("subscription");
  });

  it.each(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"])("%s in the core's env is ambiguous (env_api_key) and never reaches the child", (key) => {
    const b = box();
    const s = scripted();
    const r = run(b, s, { ...b.env, [key]: "sk-SENTINEL-KEY" });
    expect(r).toMatchObject({ verdict: "ambiguous", reasons: ["env_api_key"] });
    for (const c of s.calls) expect(Object.keys(c.env)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });

  it("a codex path that is not executable is binary_not_executable and invokes nothing", () => {
    const b = box();
    chmodSync(b.codexPath, 0o644);
    const s = scripted();
    expect(run(b, s)).toEqual({ verdict: "ambiguous", reasons: ["binary_not_executable"] });
    const gone = scripted();
    rmSync(b.codexPath);
    expect(run(b, gone).reasons).toEqual(["binary_not_executable"]);
    expect([...s.calls, ...gone.calls]).toEqual([]);
  });

  it("runs a real script: stderr carries the login line", () => {
    const b = box();
    writeFileSync(
      b.codexPath,
      `#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 0.155.1" ;;\n  login) echo "Logged in using ChatGPT" >&2 ;;\n  *) echo unexpected >&2; exit 9 ;;\nesac\n`,
      { mode: 0o755 },
    );
    expect(runCodexReadinessFor({ home: b.scoutHome, parentEnv: b.env, codexPath: b.codexPath, model: "gpt-6-sol" })).toEqual({ verdict: "subscription", reasons: [], version: "0.155.1" });
  });
});

describe("codex readiness: an npm or nvm install under launchd's PATH", () => {
  it("a `#!/usr/bin/env node` codex whose node sits beside it is subscription with a minimal parent PATH", () => {
    const b = box();
    const { codexPath, parentPath } = envNodeCodex(b.base);
    const parentEnv = { ...b.env, PATH: parentPath };
    // The premise: with the parent's PATH alone, `env` cannot find node.
    const bare = spawnSync(codexPath, ["--version"], { env: { PATH: parentPath }, encoding: "utf8" });
    expect(bare.status).toBe(127);
    expect(runCodexReadinessFor({ home: b.scoutHome, parentEnv, codexPath, model: "gpt-6-sol" })).toEqual({ verdict: "subscription", reasons: [], version: "0.155.1" });
  });

  it("both invocations get PATH with the codex directory first", () => {
    const b = box();
    const s = scripted();
    expect(run(b, s).verdict).toBe("subscription");
    for (const c of s.calls) expect(c.env.PATH).toBe(`${b.base}:/usr/bin:/bin`);
  });
});

describe("codex readiness: the private home's auth link", () => {
  it("ensureCodexHome makes a 0700 home with auth.json linked to the user's file, idempotently", () => {
    const b = box();
    const first = ensureCodexHome(b.scoutHome, b.env);
    expect(first).toEqual({ ok: true, codexHome: join(b.scoutHome, "run", "codex-home"), userAuthPath: b.authPath });
    expect(lstatSync(join(b.scoutHome, "run", "codex-home")).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(b.scoutHome, "run", "codex-home", "auth.json"))).toBe(b.authPath);
    expect(ensureCodexHome(b.scoutHome, b.env)).toEqual(first);
  });

  it("an absolute CODEX_HOME in the core's env names the user's Codex home; a relative one is ignored", () => {
    const b = box();
    const other = join(b.base, "other-codex");
    expect(ensureCodexHome(b.scoutHome, { ...b.env, CODEX_HOME: other })).toMatchObject({ ok: true, userAuthPath: join(other, "auth.json") });
    // Scout's own link is re-pointed when the user's Codex home moves.
    expect(ensureCodexHome(b.scoutHome, { ...b.env, CODEX_HOME: "rel/codex" })).toMatchObject({ ok: true, userAuthPath: b.authPath });
    expect(readlinkSync(join(b.scoutHome, "run", "codex-home", "auth.json"))).toBe(b.authPath);
  });

  it("a regular file at the link's place is never removed: auth_link_invalid", () => {
    const b = box();
    ensureCodexHome(b.scoutHome, b.env);
    const link = join(b.scoutHome, "run", "codex-home", "auth.json");
    unlinkSync(link);
    writeFileSync(link, "{}", { mode: 0o600 });
    expect(ensureCodexHome(b.scoutHome, b.env)).toEqual({ ok: false, reason: "auth_link_invalid" });
    expect(lstatSync(link).isFile()).toBe(true);
    expect(runCodexReadinessFor({ home: b.scoutHome, parentEnv: b.env, codexPath: b.codexPath, model: "m" }, { spawnSync: scripted().spawnSync })).toEqual({ verdict: "ambiguous", reasons: ["auth_link_invalid"] });
  });

  it("no HOME and no CODEX_HOME: codex_home_unusable", () => {
    const b = box();
    expect(runCodexReadinessFor({ home: b.scoutHome, parentEnv: { PATH: "/bin" }, codexPath: b.codexPath, model: "m" })).toEqual({ verdict: "ambiguous", reasons: ["codex_home_unusable"] });
  });

  it.each<[string, (b: Box) => void]>([
    ["missing", (b) => rmSync(b.authPath)],
    ["group-readable", (b) => chmodSync(b.authPath, 0o640)],
    ["a directory", (b) => (rmSync(b.authPath), mkdirSync(b.authPath))],
    ["a symlink to a private file", (b) => {
      const real = join(b.base, "real-auth.json");
      writeFileSync(real, "{}", { mode: 0o600 });
      rmSync(b.authPath);
      symlinkSync(real, b.authPath);
    }],
  ])("a target that is %s: auth_link_invalid", (_l, spoil) => {
    const b = box();
    spoil(b);
    const r = run(b, scripted());
    expect(r.verdict).toBe("ambiguous");
    expect(r.reasons).toEqual(["auth_link_invalid"]);
  });

  it("a link pointing elsewhere (edited by hand) is auth_link_invalid until ensureCodexHome re-points it", () => {
    const b = box();
    const home = ensureCodexHome(b.scoutHome, b.env);
    if (!home.ok) throw new Error("setup");
    const link = join(home.codexHome, "auth.json");
    const elsewhere = join(b.base, "elsewhere.json");
    writeFileSync(elsewhere, "{}", { mode: 0o600 });
    unlinkSync(link);
    symlinkSync(elsewhere, link);
    expect(runCodexReadiness({ codexPath: b.codexPath, parentEnv: b.env, codexHome: home.codexHome, userAuthPath: home.userAuthPath, spawnSync: scripted().spawnSync }).reasons).toEqual(["auth_link_invalid"]);
    expect(run(b, scripted()).verdict).toBe("subscription");
  });
});

describe("codex readiness facade", () => {
  const input = { home: "/h", parentEnv: { HOME: "/u", PATH: "/bin" }, codexPath: "/opt/codex", model: "gpt-6-sol" };

  it("caches a versioned report per input; one run per key in flight; another key runs again", async () => {
    let runs = 0;
    const facade = createCodexReadinessFacade({ run: async () => (runs++, { verdict: "subscription", reasons: [], version: "0.155.1" }) });
    const [a, b] = await Promise.all([facade(input), facade(input)]);
    expect(a).toBe(b);
    expect(await facade(input)).toBe(a);
    expect(runs).toBe(1);
    // A version a job saw that differs re-runs it.
    await facade(input, "0.156.0");
    expect(runs).toBe(2);
    await facade({ ...input, model: "gpt-6" });
    expect(runs).toBe(3);
    expect(readinessFingerprint({ ...input, parentEnv: { PATH: "/bin", HOME: "/u" } })).toBe(readinessFingerprint(input));
  });

  it("a report without a version is never cached", async () => {
    let runs = 0;
    const facade = createCodexReadinessFacade({ run: async () => (runs++, { verdict: "ambiguous", reasons: ["version_unknown"] }) });
    await facade(input);
    await facade(input);
    expect(runs).toBe(2);
  });

  it("cancelAll aborts a running check (ambiguous, not cached) and refuses later ones", async () => {
    const facade = createCodexReadinessFacade({
      run: (_i, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ verdict: "ambiguous", reasons: ["internal: readiness cancelled"], version: "0.155.1" }))),
    });
    const p = facade(input);
    facade.cancelAll();
    expect(await p).toMatchObject({ verdict: "ambiguous" });
    expect(await facade(input)).toEqual({ verdict: "ambiguous", reasons: ["internal: readiness cancelled"] });
    expect(facade.runs).toBe(1);
  });

  it("runs the real child entrypoint: a forked check reports back", async () => {
    const b = box();
    writeFileSync(b.codexPath, `#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 0.155.1" ;;\n  login) echo "Not logged in" >&2; exit 1 ;;\nesac\n`, { mode: 0o755 });
    const facade = createCodexReadinessFacade();
    expect(await facade({ home: b.scoutHome, parentEnv: b.env, codexPath: b.codexPath, model: "gpt-6-sol" })).toEqual({ verdict: "ambiguous", reasons: ["not_chatgpt"], version: "0.155.1" });
  });
});
