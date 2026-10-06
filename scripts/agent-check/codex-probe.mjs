// Phase 0.1 probe: one real `codex exec` through Scout's fixture backend, to see how the
// Codex CLI behaves as a non-interactive job runner before an adapter is written.
//
//   node scripts/agent-check/codex-probe.mjs --home <abs throwaway SCOUT_HOME> [--run]
//     [--codex <abs path>] [--model <m>] [--variant no-approval-mode|shell-on]
//
// Without --run it prints the argv and env key names and exits 0. With --run it makes one
// inference request on the user's ChatGPT plan, so each run needs separate authorization.
// Exit codes: 0 ran (or dry run), 1 codex failed or timed out, 2 refused, 3 not on a ChatGPT plan.
//
// The probe never prints or persists the agent token, the auth file contents, or the
// prompt's candidate lines in summary.json; events.jsonl holds whatever Codex printed.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/paths.mjs";
import { JOB_AGENT_OUTPUT_JSON_SCHEMA } from "../../packages/contracts/dist/job.js";
import { buildJobInstructions, buildJobPrompt } from "../../packages/scout-core/dist/agents/prompt.js";
import { createFixtureBackend } from "../../packages/scout-mcp/dist/fixture.js";
import { serveFixture } from "../../packages/scout-mcp/dist/test-support/fixtureSocket.js";
import { shellish } from "./report.mjs";

export const SCOUT_MCP_MAIN = join(REPO_ROOT, "packages", "scout-mcp", "dist", "main.js");
export const DEFAULT_MODEL = "gpt-6-sol";
export const VARIANTS = Object.freeze(["default", "no-approval-mode", "shell-on"]);
export const FORWARDED_ENV = Object.freeze(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]);
export const API_KEY_ENV = Object.freeze(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"]);
export const DEFAULTS = Object.freeze({ timeoutMs: 120_000, killGraceMs: 5_000, loginTimeoutMs: 20_000 });
const PROBE_ORIGIN = "https://docs.example.com";
const MAX_TURNS = 16;

/** Synthetic candidates for an example docs site; nothing real is named. */
export const PROBE_CANDIDATES = Object.freeze([
  { id: "c1", title: "Usage-based billing guide", description: "Meter API calls and invoice customers monthly", labelQuality: "published" },
  { id: "c2", title: "Webhook signatures", description: "Verify that webhook events came from the example API", labelQuality: "published" },
  { id: "c3", title: "Company careers", description: "Open roles on the example team", labelQuality: "published" },
]);

class Refusal extends Error {
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

function parseArgs(argv) {
  const o = { run: false, variant: "default", model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal(2, "bad_args", `${a} needs a value`);
      return v;
    };
    if (a === "--run") o.run = true;
    else if (a === "--home") o.home = val();
    else if (a === "--codex") o.codex = val();
    else if (a === "--model") o.model = val();
    else if (a === "--variant") o.variant = val();
    else throw new Refusal(2, "bad_args", `unknown argument ${a}`);
  }
  if (!VARIANTS.includes(o.variant)) throw new Refusal(2, "bad_args", `--variant must be one of ${VARIANTS.join(", ")}`);
  if (o.codex !== undefined && !isAbsolute(o.codex)) throw new Refusal(2, "bad_args", "--codex must be an absolute path");
  return o;
}

/** Refuses a relative --home and the real ~/.scout or anything inside it (by $HOME and by the account record). */
function checkHome(home, env, realHome) {
  if (typeof home !== "string" || !isAbsolute(home)) throw new Refusal(2, "home_not_absolute", "--home must be an absolute path");
  for (const base of new Set([env.HOME, realHome].filter(Boolean))) {
    const rel = relative(resolve(join(base, ".scout")), resolve(home));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Refusal(2, "real_scout_home", "--home must be a throwaway directory, not the real Scout home");
  }
}

function checkEnv(env) {
  const present = API_KEY_ENV.filter((k) => env[k] !== undefined);
  if (present.length > 0) throw new Refusal(2, "env_api_key", `refusing to run with ${present.join(", ")} set (API billing); unset it and re-run`);
}

export function userCodexHome(env) {
  return env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(env.HOME ?? userInfo().homedir, ".codex");
}

/** The user's auth.json must be a regular file, mode 0600, owned by this user. */
export function checkAuthTarget(target) {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    throw new Refusal(2, "auth_missing", "no auth.json in the user's Codex home");
  }
  if (!st.isFile()) throw new Refusal(2, "auth_not_regular_file", "the user's auth.json is not a regular file");
  if ((st.mode & 0o777) !== 0o600) throw new Refusal(2, "auth_bad_mode", "the user's auth.json is not mode 0600");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Refusal(2, "auth_not_owned", "the user's auth.json is not owned by this user");
}

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function childEnv(env, paths) {
  const out = {};
  for (const k of FORWARDED_ENV) if (env[k] !== undefined) out[k] = env[k];
  out.CODEX_HOME = paths.codexHome;
  out.CODEX_SQLITE_HOME = join(paths.jobDir, "state");
  return out;
}

export function probePaths(home, ts) {
  const run = join(home, "run");
  const jobDir = join(run, "jobs", `probe-${ts}`);
  return {
    home,
    run,
    agentCwd: join(run, "agent-cwd"),
    jobDir,
    codexHome: join(run, "codex-home"),
    socket: join(run, "agent.sock"),
    tokenFile: join(jobDir, "agent-token"),
    schemaFile: join(jobDir, "schema.json"),
    probeDir: join(home, "probe"),
  };
}

/** The exec argv (without the binary) for one variant. */
export function buildExecArgv({ paths, model, variant, nodePath = process.execPath, mcpMain = SCOUT_MCP_MAIN }) {
  const shellOff = variant !== "shell-on";
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    paths.agentCwd,
    "-s",
    "read-only",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "features.hooks=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'history.persistence="none"',
    "-c",
    "analytics.enabled=false",
    "-c",
    "check_for_update_on_startup=false",
    ...(shellOff ? ["-c", 'web_search="disabled"', "-c", "features.shell_tool=false"] : []),
    "--disable",
    "apps",
    "-c",
    `mcp_servers.scout.command=${JSON.stringify(nodePath)}`,
    "-c",
    `mcp_servers.scout.args=${JSON.stringify([mcpMain, "--socket", paths.socket, "--token-file", paths.tokenFile])}`,
    "-c",
    "mcp_servers.scout.required=true",
    "-c",
    "mcp_servers.scout.startup_timeout_sec=10",
    ...(variant === "no-approval-mode" ? [] : ["-c", 'mcp_servers.scout.default_tools_approval_mode="approve"']),
    "--output-schema",
    paths.schemaFile,
    "-",
  ];
}

export function buildProbePrompt() {
  return `Instructions\n${buildJobInstructions(MAX_TURNS)}\n${buildJobPrompt({ origin: PROBE_ORIGIN, candidates: PROBE_CANDIDATES.map((c) => ({ ...c })), maxPicks: 3 })}`;
}

function privateDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  const st = lstatSync(p);
  if (!st.isDirectory()) throw new Refusal(2, "not_a_directory", `${p} is not a directory`);
  chmodSync(p, 0o700);
}

/** Relative paths, types and sizes under `root`; symlinks are shown as links, never followed. */
export function listTree(root, tilde = (s) => s) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      const rel = relative(root, p);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) out.push({ path: rel, type: "symlink", target: tilde(readlinkSync(p)) });
      else if (st.isDirectory()) {
        out.push({ path: rel, type: "dir" });
        walk(p);
      } else out.push({ path: rel, type: st.isSocket() ? "socket" : "file", size: st.size, mode: (st.mode & 0o777).toString(8) });
    }
  };
  walk(root);
  return out;
}

/** Counts and flags from the JSONL events; no tool arguments or results. */
export function summarizeEvents(text) {
  const itemTypes = {};
  const mcpToolCalls = [];
  const errors = [];
  let lastAgentMessage;
  let usage;
  let turnFailed;
  let nonJsonLines = 0;
  const eventTypes = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      nonJsonLines++;
      continue;
    }
    eventTypes[ev?.type] = (eventTypes[ev?.type] ?? 0) + 1;
    if (ev?.type === "item.completed" && ev.item) {
      const t = ev.item.type;
      itemTypes[t] = (itemTypes[t] ?? 0) + 1;
      if (t === "agent_message") lastAgentMessage = ev.item.text;
      if (t === "mcp_tool_call") mcpToolCalls.push({ server: ev.item.server, tool: ev.item.tool, status: ev.item.status, hasError: ev.item.error != null });
    }
    if (ev?.type === "turn.completed") usage = ev.usage;
    if (ev?.type === "turn.failed") turnFailed = String(ev.error?.message ?? "").slice(0, 500);
    if (ev?.type === "error") errors.push(String(ev.message ?? "").slice(0, 500));
  }
  let finalOutput;
  if (lastAgentMessage === undefined) finalOutput = { absent: true };
  else {
    try {
      finalOutput = { parsed: JSON.parse(lastAgentMessage) };
    } catch (e) {
      finalOutput = { parseError: e.message };
    }
  }
  return {
    eventTypes,
    itemTypes,
    mcpToolCalls,
    sawCommandExecution: Boolean(itemTypes.command_execution),
    sawWebSearch: Boolean(itemTypes.web_search),
    sawFileChange: Boolean(itemTypes.file_change),
    finalOutput,
    usage,
    turnFailed,
    errors,
    nonJsonLines,
  };
}

const authStat = (p) => {
  try {
    const st = statSync(p);
    return { ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
};

/**
 * @param {string[]} argv
 * @param {object} deps  env, out, err, realHome (account home; tests only), timeoutMs,
 *   killGraceMs, loginTimeoutMs, now, abortSignal
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const realHome = deps.realHome ?? userInfo().homedir;
  const timeoutMs = deps.timeoutMs ?? DEFAULTS.timeoutMs;
  const killGraceMs = deps.killGraceMs ?? DEFAULTS.killGraceMs;
  const homeAbs = env.HOME ?? realHome;
  const tilde = (s) => (homeAbs && typeof s === "string" ? s.split(homeAbs).join("~") : s);

  try {
    const o = parseArgs(argv);
    checkHome(o.home, env, realHome);
    checkEnv(env);
    const home = resolve(o.home);
    const ts = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    const paths = probePaths(home, ts);
    const codex = o.codex ?? findOnPath("codex", env);
    const cEnv = childEnv(env, paths);
    const execArgv = buildExecArgv({ paths, model: o.model, variant: o.variant });
    const authTarget = join(userCodexHome(env), "auth.json");

    if (!o.run) {
      out("codex-probe dry run: nothing is written or launched.");
      out(`  codex: ${codex ?? "codex (not found on PATH)"}`);
      out(`  variant: ${o.variant}`);
      out(`  cwd: ${paths.agentCwd}`);
      out(`  job dir: ${paths.jobDir}`);
      out(`  codex home: ${paths.codexHome} (auth.json -> ${tilde(authTarget)})`);
      out(`  env keys: ${Object.keys(cEnv).join(", ")}`);
      out(`  argv: ${[codex ?? "codex", ...execArgv].map(shellish).join(" ")}`);
      out(`  record: ${paths.probeDir}/{events.jsonl,stderr.log,summary.json}`);
      out("  inference requests: 1 (with --run)");
      return 0;
    }

    if (!codex) throw new Refusal(2, "codex_not_found", "no codex on PATH; pass --codex <abs path>");
    checkAuthTarget(authTarget);

    privateDir(home);
    privateDir(paths.run);
    privateDir(paths.agentCwd);
    privateDir(join(paths.run, "jobs"));
    privateDir(paths.jobDir);
    privateDir(paths.codexHome);
    privateDir(paths.probeDir);
    const link = join(paths.codexHome, "auth.json");
    try {
      const st = lstatSync(link);
      if (!st.isSymbolicLink() || readlinkSync(link) !== authTarget) throw new Refusal(2, "codex_home_auth_foreign", "the throwaway codex home already has a different auth.json");
    } catch (e) {
      if (e instanceof Refusal) throw e;
      symlinkSync(authTarget, link);
    }

    const login = spawnSync(codex, ["login", "status"], {
      env: cEnv,
      cwd: paths.agentCwd,
      timeout: deps.loginTimeoutMs ?? DEFAULTS.loginTimeoutMs,
      killSignal: "SIGKILL",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (login.status !== 0 || !String(login.stderr ?? "").includes("Logged in using ChatGPT")) {
      const why = login.error ? login.error.code : login.signal ? `signal ${login.signal}` : `exit ${login.status}`;
      err(`codex-probe: refused (not_chatgpt, ${why}): codex login status did not report a ChatGPT login`);
      return 3;
    }
    const ver = spawnSync(codex, ["--version"], { env: cEnv, cwd: paths.agentCwd, timeout: 20_000, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const codexVersion = String(ver.stdout ?? "").trim() || null;

    const authBefore = authStat(authTarget);
    const token = randomBytes(24).toString("base64url");
    try {
      if (lstatSync(paths.socket).isSocket()) unlinkSync(paths.socket);
    } catch {
      // none
    }
    const backend = await createFixtureBackend({
      coreInstanceId: "core-probe",
      token,
      browserContextGranted: true,
      currentSite: { origin: PROBE_ORIGIN, url: `${PROBE_ORIGIN}/billing`, title: "Billing documentation", visitEpoch: 7 },
      activity: [
        {
          origin: "https://github.com",
          url: "https://github.com/example-org/example-api/issues/42",
          observedAt: Date.now() - 60_000,
          title: "Charge customers per API call",
          text: "Synthetic issue: we need usage-based billing. Meter each API call and send customers a monthly invoice.",
          textTruncated: false,
        },
      ],
    });
    const fixture = await serveFixture(backend, paths.socket);
    const fixtureState = { started: true, stopped: false };
    let result;
    try {
      writeFileSync(paths.tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
      // OpenAI strict structured outputs: every property required, no pattern/min/max keywords.
      // `{status:"empty", items:[]}` is the empty answer; the adapter drops the empty list before validation.
      const strictSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["ok", "empty"] },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, reason: { type: "string" } },
              required: ["id", "reason"],
            },
          },
        },
        required: ["status", "items"],
      };
      void JOB_AGENT_OUTPUT_JSON_SCHEMA;
      writeFileSync(paths.schemaFile, `${JSON.stringify(strictSchema, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const prompt = buildProbePrompt();
      result = await runExec({ codex, execArgv, env: cEnv, cwd: paths.agentCwd, prompt, probeDir: paths.probeDir, timeoutMs, killGraceMs, abortSignal: deps.abortSignal });
      result.promptBytes = Buffer.byteLength(prompt);
    } finally {
      fixtureState.requestMethods = fixture.requests.map((r) => r.method).reduce((acc, m) => ({ ...acc, [m]: (acc[m] ?? 0) + 1 }), {});
      fixtureState.openConnectionsAtStop = fixture.openConnections;
      await fixture.close();
      fixtureState.stopped = true;
    }

    const authAfter = authStat(authTarget);
    const events = summarizeEvents(readFileSync(join(paths.probeDir, "events.jsonl"), "utf8"));
    const summary = {
      variant: o.variant,
      model: o.model,
      codexVersion,
      argv: [codex, ...execArgv].map(tilde),
      envKeys: Object.keys(cEnv),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      promptBytes: result.promptBytes,
      ...events,
      codexHomeAfter: listTree(paths.codexHome, tilde),
      userAuth: {
        inodeChanged: authBefore?.ino !== authAfter?.ino,
        mtimeChanged: authBefore?.mtimeMs !== authAfter?.mtimeMs,
      },
      jobDirAfter: listTree(paths.jobDir, tilde),
      sqliteStateCreated: listTree(paths.jobDir).some((e) => e.path === "state"),
      fixture: fixtureState,
    };
    const text = JSON.stringify(summary, null, 2);
    writeFileSync(join(paths.probeDir, "summary.json"), `${text}\n`, { mode: 0o600 });
    out(text);
    return result.exitCode === 0 && !result.timedOut ? 0 : 1;
  } catch (e) {
    if (e instanceof Refusal) {
      err(`codex-probe: refused (${e.reason}): ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

function runExec({ codex, execArgv, env, cwd, prompt, probeDir, timeoutMs, killGraceMs, abortSignal }) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const stdoutFile = createWriteStream(join(probeDir, "events.jsonl"), { mode: 0o600 });
    const stderrFile = createWriteStream(join(probeDir, "stderr.log"), { mode: 0o600 });
    const child = spawn(codex, execArgv, { env, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let timedOut = false;
    let killTimer;
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // gone
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.pipe(stdoutFile);
    child.stderr.pipe(stderrFile);
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    let spawnError;
    child.once("error", (e) => {
      spawnError = e.code;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      // Anything left in the group (an MCP server, a stray helper) goes too.
      if (child.pid !== undefined) killGroup("SIGKILL");
      let pending = 2;
      const done = () => {
        if (--pending === 0) resolveRun({ exitCode: code, signal, timedOut, durationMs: Date.now() - t0, spawnError });
      };
      stdoutFile.end(done);
      stderrFile.end(done);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => ac.abort(sig));
  main(process.argv.slice(2), { abortSignal: ac.signal }).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`codex-probe: ${e?.stack ?? e}\n`);
      process.exit(1);
    },
  );
}
