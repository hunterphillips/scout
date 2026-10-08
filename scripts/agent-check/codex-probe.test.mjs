// codex-probe.mjs against a fake `codex` (sh). No test invokes the real codex.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, PROBE_CANDIDATES } from "./codex-probe.mjs";
import { makeThrowawayRoot } from "./fixtures.mjs";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
});

/** A temp world: fake HOME with ~/.codex/auth.json (0600) and a fake codex whose answers come from files. */
function world({ loginExit = 0, loginText = "Logged in using ChatGPT" } = {}) {
  const t = makeThrowawayRoot("cprobe-");
  roots.push(t);
  const root = t.root;
  const userHome = join(root, "u");
  const codexDir = join(userHome, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const auth = join(codexDir, "auth.json");
  writeFileSync(auth, '{"auth":"SENTINEL-AUTH-CONTENT"}', { mode: 0o600 });
  chmodSync(auth, 0o600);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "fake.log");
  writeFileSync(join(root, "login-exit"), String(loginExit));
  writeFileSync(join(root, "login-text"), loginText);
  const codex = join(bin, "codex");
  writeFileSync(
    codex,
    `#!/bin/sh
echo "argv: $*" >> '${log}'
case "$1" in
  --version) echo "codex-cli 0.155.1"; exit 0 ;;
  login)
    env | cut -d= -f1 | sort | tr '\\n' ' ' | sed 's/^/loginenv: /' >> '${log}'; echo >> '${log}'
    cat '${join(root, "login-text")}' >&2
    exit "$(cat '${join(root, "login-exit")}')" ;;
  exec)
    cat > '${join(root, "stdin.txt")}'
    env | cut -d= -f1 | sort | tr '\\n' ' ' | sed 's/^/execenv: /' >> '${log}'; echo >> '${log}'
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"item.completed","item":{"id":"i0","type":"mcp_tool_call","server":"scout","tool":"current_site","arguments":{},"result":{"secret":"ARG-RESULT"},"error":null,"status":"completed"}}'
    echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"status\\":\\"empty\\"}"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}'
    echo "some stderr" >&2
    exit 0 ;;
esac
exit 9
`,
  );
  chmodSync(codex, 0o755);
  const env = {
    HOME: userHome,
    USER: "someone",
    PATH: `${bin}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
    UNRELATED_SECRET: "SENTINEL-ENV",
  };
  const home = join(root, "h");
  return {
    root,
    userHome,
    auth,
    codex,
    env,
    home,
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    stdin: () => readFileSync(join(root, "stdin.txt"), "utf8"),
    async run(args, extra = {}) {
      const outLines = [];
      const errLines = [];
      const code = await main(args, { env, realHome: userHome, out: (s) => outLines.push(s), err: (s) => errLines.push(s), killGraceMs: 200, ...extra });
      return { code, out: outLines.join("\n"), err: errLines.join("\n") };
    },
  };
}

describe("codex-probe dry run", () => {
  it("prints the argv with the expected flags and nothing unsafe, and writes nothing", async () => {
    const w = world();
    const r = await w.run(["--home", w.home, "--codex", w.codex]);
    expect(r.code).toBe(0);
    for (const f of [
      "exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check",
      "--color never",
      "-s read-only",
      "-m gpt-6-luna",
      "features.shell_tool=false",
      `'web_search="disabled"'`,
      "--disable apps",
      "mcp_servers.scout.required=true",
      "mcp_servers.scout.default_tools_approval_mode",
      `--output-schema ${w.home}/run/jobs/probe-`,
      `${w.home}/run/agent.sock`,
      "/agent-token",
    ])
      expect(r.out).toContain(f);
    for (const bad of ["--yolo", "--full-auto", "--dangerously", "workspace-write"]) expect(r.out).not.toContain(bad);
    expect(r.out).toContain("env keys: HOME, USER, PATH, SHELL, LANG, TMPDIR, CODEX_HOME, CODEX_SQLITE_HOME");
    expect(r.out).not.toContain("UNRELATED_SECRET");
    expect(existsSync(w.home)).toBe(false);
    expect(w.lines()).toEqual([]);
  });

  it("variants drop their lines", async () => {
    const w = world();
    const a = await w.run(["--home", w.home, "--codex", w.codex, "--variant", "no-approval-mode"]);
    expect(a.out).not.toContain("default_tools_approval_mode");
    expect(a.out).toContain("features.shell_tool=false");
    const b = await w.run(["--home", w.home, "--codex", w.codex, "--variant", "shell-on"]);
    expect(b.out).not.toContain("shell_tool");
    expect(b.out).not.toContain("web_search");
    expect(b.out).toContain("default_tools_approval_mode");
    expect((await w.run(["--home", w.home, "--variant", "bogus"])).code).toBe(2);
  });
});

describe("codex-probe refusals", () => {
  it("refuses a relative home and the real ~/.scout", async () => {
    const w = world();
    expect((await w.run(["--home", "rel/dir"])).code).toBe(2);
    const r = await w.run(["--home", join(w.userHome, ".scout"), "--run", "--codex", w.codex]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("real_scout_home");
    expect((await w.run(["--home", join(w.userHome, ".scout", "x"), "--codex", w.codex])).code).toBe(2);
    expect(w.lines()).toEqual([]);
  });

  it.each(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"])("refuses with %s in the env", async (k) => {
    const w = world();
    w.env[k] = "SENTINEL-KEY";
    const r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("env_api_key");
    expect(r.err).not.toContain("SENTINEL-KEY");
    expect(w.lines()).toEqual([]);
  });

  it("refuses an auth.json that is missing, not 0600, or a symlink", async () => {
    const w = world();
    chmodSync(w.auth, 0o644);
    let r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect([r.code, r.err]).toEqual([2, expect.stringContaining("auth_bad_mode")]);
    rmSync(w.auth);
    writeFileSync(join(w.root, "real-auth"), "{}", { mode: 0o600 });
    symlinkSync(join(w.root, "real-auth"), w.auth);
    r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect([r.code, r.err]).toEqual([2, expect.stringContaining("auth_not_regular_file")]);
    rmSync(w.auth);
    r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect([r.code, r.err]).toEqual([2, expect.stringContaining("auth_missing")]);
    expect(w.lines()).toEqual([]);
  });

  it("uses an absolute $CODEX_HOME for the auth target", async () => {
    const w = world();
    const other = join(w.root, "ch");
    mkdirSync(other);
    w.env.CODEX_HOME = other;
    const r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect([r.code, r.err]).toEqual([2, expect.stringContaining("auth_missing")]);
  });

  it.each([
    [1, "Not logged in"],
    [0, "Logged in using an API key - sk-***"],
  ])("exits 3 when login status is exit %i %s, before any exec", async (loginExit, loginText) => {
    const w = world({ loginExit, loginText });
    const r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("not_chatgpt");
    expect(r.err).not.toContain("sk-");
    expect(w.lines().some((l) => l.startsWith("argv: exec"))).toBe(false);
  });
});

describe("codex-probe run against a fake codex", () => {
  it("records events, stderr and a summary; starts and stops the fixture", async () => {
    const w = world();
    const r = await w.run(["--home", w.home, "--run", "--codex", w.codex]);
    expect(r.code, r.err).toBe(0);
    const probe = join(w.home, "probe");
    const summaryText = readFileSync(join(probe, "summary.json"), "utf8");
    const s = JSON.parse(summaryText);
    expect(s).toMatchObject({
      variant: "default",
      model: "gpt-6-luna",
      codexVersion: "codex-cli 0.155.1",
      exitCode: 0,
      signal: null,
      timedOut: false,
      itemTypes: { mcp_tool_call: 1, agent_message: 1 },
      mcpToolCalls: [{ server: "scout", tool: "current_site", status: "completed", hasError: false }],
      sawCommandExecution: false,
      sawWebSearch: false,
      sawFileChange: false,
      finalOutput: { parsed: { status: "empty" } },
      usage: { input_tokens: 10, output_tokens: 5 },
      userAuth: { inodeChanged: false, mtimeChanged: false },
      sqliteStateCreated: false,
      fixture: { started: true, stopped: true, openConnectionsAtStop: 0 },
    });
    expect(s.durationMs).toBeTypeOf("number");
    expect(s.codexHomeAfter).toEqual([{ path: "auth.json", type: "symlink", target: "~/.codex/auth.json" }]);
    expect(s.jobDirAfter.map((e) => e.path).sort()).toEqual(["agent-token", "schema.json"]);
    expect(s.envKeys).toEqual(["HOME", "USER", "PATH", "SHELL", "LANG", "TMPDIR", "CODEX_HOME", "CODEX_SQLITE_HOME"]);
    expect(r.out).toBe(summaryText.trimEnd());
    expect(readFileSync(join(probe, "stderr.log"), "utf8")).toBe("some stderr\n");
    expect(readFileSync(join(probe, "events.jsonl"), "utf8")).toContain("thread.started");

    // Nothing secret or prompt-derived in the summary.
    const token = readFileSync(join(w.home, "run", "jobs", readdirSync(join(w.home, "run", "jobs"))[0], "agent-token"), "utf8").trim();
    for (const bad of [token, "SENTINEL-AUTH-CONTENT", "SENTINEL-ENV", "ARG-RESULT", ...PROBE_CANDIDATES.map((c) => c.title)]) expect(summaryText).not.toContain(bad);

    // The layout and the auth symlink.
    const ch = join(w.home, "run", "codex-home");
    expect(readlinkSync(join(ch, "auth.json"))).toBe(w.auth);
    for (const d of [join(w.home, "run"), join(w.home, "run", "agent-cwd"), ch]) expect(lstatSync(d).mode & 0o777).toBe(0o700);
    // The fixture socket is gone after stop.
    expect(existsSync(join(w.home, "run", "agent.sock"))).toBe(false);

    // The exec got the prompt on stdin and only the allowed env.
    const stdin = w.stdin();
    expect(stdin.startsWith("Instructions\n## Scout recommendation job")).toBe(true);
    expect(stdin).toContain("Site origin: https://docs.example.com");
    expect(stdin).toContain("c1 | Usage-based billing guide");
    const execEnv = w.lines().find((l) => l.startsWith("execenv: "));
    expect(execEnv).toContain("CODEX_HOME");
    expect(execEnv).toContain("CODEX_SQLITE_HOME");
    expect(execEnv).not.toContain("UNRELATED_SECRET");
    expect(w.lines().find((l) => l.startsWith("argv: exec"))).toContain("--output-schema");
  });

  it("kills the process group on timeout and still writes the summary", async () => {
    const w = world();
    // Replace exec with one that hangs.
    const src = readFileSync(w.codex, "utf8").replace("exec)\n", "exec)\n    sleep 30\n");
    writeFileSync(w.codex, src);
    const r = await w.run(["--home", w.home, "--run", "--codex", w.codex], { timeoutMs: 300 });
    expect(r.code).toBe(1);
    const s = JSON.parse(readFileSync(join(w.home, "probe", "summary.json"), "utf8"));
    expect(s).toMatchObject({ timedOut: true, signal: "SIGTERM", finalOutput: { absent: true }, fixture: { stopped: true } });
  });
});
