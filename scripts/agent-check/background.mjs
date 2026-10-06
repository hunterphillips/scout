// Background-job checks through the real job adapter (scout-core dist; the registry builds
// the one the check's agent profile names: Claude Code by default, Codex with
// `--adapter codex`), one inference request each, against a fixture core on a temp socket and a
// throwaway --home:
//
//   baseline       Scout context only; expects `ok` with at least one pick and Scout tool use
//   selected-tool  plus one selected synthetic stdio tool (fake-backend.mjs behind the per-job
//                  bridge, literal env only); expects the bridged tool to be called
//   cancel         aborts the job a few seconds after its init event; expects `cancelled`, no
//                  process left from the job's tree, no open fixture connection, job dir gone
//
// The adapter's readiness check runs first (Claude Code: the direct billing preflight; Codex:
// `codex --version` and `codex login status`); nothing launches unless it reports
// `subscription`. The job's argv and first event (Claude's init, Codex's `thread.started`) are
// captured through the adapter's spawn seam for the report.

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildJobArgv } from "../../packages/scout-core/dist/agents/claudeCode/claudeJob.js";
import { runDirectPreflight } from "../../packages/scout-core/dist/agents/claudeCode/launchProfile.js";
import { buildCodexArgv } from "../../packages/scout-core/dist/agents/codex/launch.js";
import { OwnedTree, psSnapshot } from "../../packages/scout-core/dist/agents/processTree.js";
import { loadAgentProfile, writeAgentProfile } from "../../packages/scout-core/dist/agents/profile.js";
import { createJobAdapter } from "../../packages/scout-core/dist/agents/registry.js";
import { errorCode } from "./classify.mjs";
import { checkModel, checkProfile, jobRequest, makeThrowawayRoot, selectedToolProfile, startJobFixture } from "./fixtures.mjs";
import { buildReport, shellish, summarizeInit } from "./report.mjs";

export const BACKGROUND_CASES = Object.freeze(["baseline", "selected-tool", "cancel"]);
export const BACKGROUND_DEFAULTS = Object.freeze({ cancelAfterInitMs: 3000 });
const BRIDGED_TOOL = "mcp__scout_bridge__lookup";

/** One backend log line, or undefined if it is not JSON (a torn or foreign line). */
const parseLogLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await delay(50);
  return pred();
}

/**
 * @param {string} caseName  one of BACKGROUND_CASES
 * @param {object} o  home, env, adapter (`claude-code` or `codex`), agentPath, maxInference, dryRun
 * @param {object} deps  out, err, and test seams: cancelAfterInitMs, preflightSeams
 *   ({ managedPaths }), killGraceMs, hooks.onStart
 */
export async function runBackground(caseName, o, deps) {
  const { out } = deps;
  if (o.maxInference < 1) {
    deps.err(`verify:agent ${caseName}: needs --max-inference of at least 1`);
    return { code: 2 };
  }
  const requestId = `check-${randomBytes(6).toString("hex")}`;
  const jobDir = join(o.home, "run", "jobs", requestId);
  const adapterId = o.adapter ?? "claude-code";
  const codex = adapterId === "codex";
  const model = checkModel(adapterId);

  if (o.dryRun) {
    const short = (args) => args.map((a) => shellish(a.length > 60 ? `${a.slice(0, 57)}...` : a)).join(" ");
    const jobArgv = codex
      ? buildCodexArgv({
          cwd: join(o.home, "run", "agent-cwd"),
          model,
          reasoningEffort: "low",
          schemaFile: join(jobDir, "schema.json"),
          surface: { expected: [{ name: "scout", required: true }], mcpConfig: { mcpServers: { scout: { command: process.execPath, args: ["<scout-mcp>", "--socket", "<throwaway>/a.sock", "--token-file", join(jobDir, "agent-token")] } } } },
        })
      : buildJobArgv(model, jobDir, "<Scout tools" + (caseName === "selected-tool" ? ` + ${BRIDGED_TOOL}` : "") + ">");
    const lines = [
      `verify:agent ${caseName} --dry-run: nothing is written or launched.`,
      `  adapter: ${adapterId}`,
      `  ${codex ? "codex" : "claude"}: ${o.agentPath}`,
      `  model: ${model}`,
      `  agent profile: ${join(o.home, "agent-profile.json")}${caseName === "selected-tool" ? " (plus one selected synthetic tool: lookup on fake-backend.mjs, literal env only)" : ""}`,
      codex
        ? `  readiness: codex --version and codex login status (ChatGPT login only) before any launch; private Codex home ${join(o.home, "run", "codex-home")}`
        : "  preflight: direct billing preflight (claude --version, auth status) before any launch",
      `  job: ${o.agentPath} ${short(jobArgv)}${codex && caseName === "selected-tool" ? " (plus the scout_bridge server)" : ""}`,
      "  fixture: synthetic Scout core on <throwaway>/a.sock (current site docs.example.com, one synthetic GitHub issue)",
      caseName === "cancel" ? `  cancel: abort ${(deps.cancelAfterInitMs ?? BACKGROUND_DEFAULTS.cancelAfterInitMs) / 1000} s after the init event, then check processes, connections and the job dir` : "  expects: ok with at least one pick",
      "  inference requests: 1",
      `  report: ${join(o.home, "agent-check", `${caseName}-<timestamp>.json`)}`,
    ];
    for (const l of lines) out(l);
    return { code: 0 };
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const failures = [];
  const inference = [];
  const secrets = [];
  const throwaway = makeThrowawayRoot("scout-bg-");
  let fixture;
  let adapter;
  let argv = [];
  let init;
  let childPid;
  let tree;
  let treePoller;
  let outcome = "aborted";
  let preflight = { verdict: "not run" };
  let job;
  let selected;
  let cancelAt;
  const cleanup = { ok: false };
  const ac = new AbortController();
  // run.mjs's abort (SIGINT/SIGTERM/uncaught error): cancel the job; cleanup below still runs.
  let externalAbort;
  let cancelTimer;
  const onExternalAbort = () => {
    externalAbort = typeof deps.abortSignal?.reason === "string" ? deps.abortSignal.reason : "signal";
    ac.abort("aborted");
  };
  if (deps.abortSignal?.aborted) onExternalAbort();
  else deps.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  // The adapter's spawn, observed: argv, child pid, and the init event (for the report and the cancel timer).
  const spawn = (command, args, options) => {
    argv = [command, ...args];
    const child = nodeSpawn(command, [...args], options);
    childPid = child.pid;
    if (childPid !== undefined) {
      // The job's process tree, recorded while it runs, so cleanup can be checked afterwards.
      tree = new OwnedTree(childPid);
      tree.poll(psSnapshot());
      treePoller = setInterval(() => tree.poll(psSnapshot()), 500);
      child.once("exit", () => clearInterval(treePoller));
    }
    let buf = "";
    child.stdout?.on("data", (chunk) => {
      if (init) return;
      buf += String(chunk);
      for (let i = buf.indexOf("\n"); i >= 0 && !init; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if ((ev?.type === "system" && ev.subtype === "init") || ev?.type === "thread.started") onInit(ev);
        } catch {
          // not an event
        }
      }
      if (buf.length > 1024 * 1024) buf = "";
    });
    return child;
  };
  const onInit = (ev) => {
    init = ev;
    if (caseName !== "cancel") return;
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      tree?.poll(psSnapshot());
      cancelAt = Date.now() - t0;
      ac.abort("superseded");
    }, deps.cancelAfterInitMs ?? BACKGROUND_DEFAULTS.cancelAfterInitMs);
  };

  try {
    fixture = await startJobFixture(throwaway.root);
    secrets.push(fixture.token);
    await deps.hooks?.onStart?.({ token: fixture.token, root: throwaway.root });
    if (caseName === "selected-tool") selected = selectedToolProfile(throwaway.root);
    writeAgentProfile(o.home, checkProfile(adapterId, o.agentPath, selected?.tools));
    const profile = loadAgentProfile(o.home);
    const seams = deps.preflightSeams ?? {};
    const common = { spawn, ...(deps.killGraceMs ? { killGraceMs: deps.killGraceMs } : {}) };
    adapter = createJobAdapter(profile, {
      home: o.home,
      parentEnv: o.env,
      seams: {
        "claude-code": {
          ...common,
          preflight: (opts) => runDirectPreflight({ ...opts, ...seams }),
          ...(seams.managedPaths ? { managedPaths: seams.managedPaths } : {}),
        },
        codex: common,
      },
    });
    const pf = await adapter.refreshReadiness();
    preflight = { verdict: pf.verdict, reasons: [...pf.reasons], cliVersion: pf.version };
    if (pf.verdict !== "subscription") {
      outcome = "preflight_failed";
      failures.push("preflight");
    } else if (!ac.signal.aborted) {
      inference.push({ n: 1, purpose: caseName, at: new Date().toISOString() });
      const request = jobRequest({ requestId, coreInstanceId: fixture.coreInstanceId, profileFingerprint: adapter.profileFingerprint });
      job = await adapter.run(request, { toolSurface: { scout: { socketPath: fixture.socketPath, token: fixture.token } }, signal: ac.signal });
      const r = job.result;
      const d = job.details;
      if (caseName === "cancel") {
        outcome = r.status === "cancelled" ? "cancelled" : `not_cancelled_${r.status}`;
        if (r.status !== "cancelled") failures.push("not_cancelled");
      } else {
        const picked = r.status === "ok" && r.items.length >= 1;
        const usedScout = d.toolUses.some((t) => t.startsWith("mcp__scout__"));
        outcome = r.status === "ok" ? "ok" : `${r.status}_${r.reason ?? ""}`.replace(/_$/, "");
        if (!picked) failures.push("no_valid_pick");
        if (!usedScout) failures.push("scout_tools_not_used");
        if (caseName === "selected-tool") {
          const backendCalls = existsSync(selected.log)
            ? readFileSync(selected.log, "utf8").split("\n").filter(Boolean).map(parseLogLine).filter((l) => l?.method === "tools/call" && l.tool === "lookup").length
            : 0;
          selected.evidence = {
            bridgedToolUsed: d.toolUses.includes(BRIDGED_TOOL),
            backendCalls,
            proofPhraseInReasons: r.status === "ok" && r.items.some((i) => i.reason.includes(selected.proofPhrase)),
            optionalTools: d.optionalTools,
          };
          if (!selected.evidence.bridgedToolUsed || backendCalls < 1) failures.push("selected_tool_not_called");
        }
      }
    }
  } catch (e) {
    failures.push(errorCode(e));
  } finally {
    clearTimeout(cancelTimer);
    await adapter?.abortAll().catch(() => {});
    clearInterval(treePoller);
    cleanup.jobDirRemoved = !existsSync(jobDir);
    if (tree) {
      await waitFor(() => tree.alive(psSnapshot()).length === 0, 3000);
      cleanup.processesSeen = tree.identities().length;
      cleanup.processesRemaining = tree.alive(psSnapshot()).length;
    } else cleanup.processesRemaining = 0;
    if (fixture) {
      await waitFor(() => fixture.openConnections() === 0, 2000);
      cleanup.fixtureConnectionsAtEnd = fixture.openConnections();
      await fixture.close();
    }
    throwaway.remove();
    cleanup.throwawayRemoved = !existsSync(throwaway.root);
    cleanup.ok = cleanup.jobDirRemoved && cleanup.processesRemaining === 0 && (cleanup.fixtureConnectionsAtEnd ?? 0) === 0 && cleanup.throwawayRemoved;
    if (!cleanup.ok) failures.push("cleanup_incomplete");
    deps.abortSignal?.removeEventListener("abort", onExternalAbort);
  }
  if (externalAbort) {
    outcome = "aborted";
    failures.push(`aborted_${/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(externalAbort) ? externalAbort : "signal"}`);
  }

  const pass = failures.length === 0 && (caseName === "cancel" ? outcome === "cancelled" : outcome === "ok");
  const r = job?.result;
  const d = job?.details;
  const report = buildReport(caseName, {
    pass,
    outcome,
    failures,
    startedAt,
    totalMs: Date.now() - t0,
    adapter: adapterId,
    cli: { path: o.agentPath, version: preflight.cliVersion },
    preflight,
    argv,
    init: codex ? { seen: init !== undefined, event: "thread.started" } : summarizeInit(init, { server: (n) => n === "scout" || n === "scout_bridge", tool: () => true, skill: () => false }),
    result: r && {
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.status === "ok" ? { items: r.items.map((i) => ({ id: i.id, reason: i.reason })) } : {}),
    },
    details: d && {
      termination: d.termination,
      detail: d.detail,
      cliVersion: d.cliVersion,
      model: d.model,
      toolUses: d.toolUses,
      optionalTools: d.optionalTools,
      droppedPicks: d.droppedPicks,
      cutPicks: d.cutPicks,
      timings: d.timings,
      usage: d.usage,
    },
    selectedTool: selected?.evidence,
    cancel: caseName === "cancel" ? { cancelAfterInitMs: deps.cancelAfterInitMs ?? BACKGROUND_DEFAULTS.cancelAfterInitMs, cancelledAtMs: cancelAt } : undefined,
    inferenceRequests: inference,
    cleanup,
  });
  return { code: pass ? 0 : 1, report, secrets };
}
