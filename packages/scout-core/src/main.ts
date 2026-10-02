// Scout core process entrypoint. The native app launches
//   node packages/scout-core/dist/main.js --stdio
// and speaks JSONL on stdin (NativeCommand) and stdout (PanelState). Logs go to stderr
// only. The native host reaches the core on <scoutHome>/run/core.sock.
//
// Scout's MCP adapter reaches it on <scoutHome>/run/agent.sock with the token in
// <scoutHome>/run/agent-token, both published only after the capability store is open and
// its startup export sync has settled.
//
// Settled visits run resource discovery (coordinator.ts); shutdown stops the coordinator
// first, which cancels any pending dwell. SCOUT_DWELL_MS overrides the dwell for tests
// only (so a test's real visits never settle into real fetches); anything but a positive
// integer that a Node timer can hold falls back to DWELL_MS.
//
// The core opens the capability store once for its lifetime (its lock keeps the dev CLI
// from writing meanwhile), collects garbage at start and hourly, and wires the store's
// revocation hook to the agent socket. Skill wrappers are exported only when the
// installer's record (installed.json) names a skills root.
//
// Accepted GitHub issue text lives in the in-memory activity store; each background job reads
// only its own immutable snapshot (activity/snapshots.ts), built once the agent auth exists.
// Pause and shutdown release every snapshot and revoke every job token (shutdown does it
// before closing agent.sock, and no snapshot is taken after it or while paused); a revoked
// resource releases the snapshots that pinned it; expired snapshots are released before
// each collection.
//
// Scout's window gets its capability view, previews, command acks, the context-read audit,
// and the browser-context grant from the panel channel (panelChannel.ts), which starts right
// after the coordinator and stops right after it, before the sockets and the store close.
// Recommendation results live in one registry (results.ts) shared by the channel (frames,
// `open_link`) and the coordinator (which clears them with their visit); results may be
// published only for the coordinator's current, unpaused, permitted visit.
//
// Recommendation jobs: wiring/jobs.ts builds the adapter for `agent-profile.json` (without a
// usable profile every job is `unavailable`), its billing preflight in a killable child process
// (started at once only when some host is recommendation-enabled), the catalog parse worker a
// cancelled discovery pass cancels too, and the scheduler. Every panel frame passes through it,
// so the scheduler hears the browser-context grant as the window does; revoked resources reach
// it through the store's revocation hook, after agent.sock released the snapshots that pinned
// them.
//
// Shutdown (P3.4), one function, one order, every trigger: stdin EOF (the app quit), stdin
// closed abruptly (the app crashed), a read error on stdin, a stdout error, the `shutdown`
// command, SIGTERM, SIGINT, SIGHUP.
//   1. stop accepting (synchronous, nothing awaited before it): the coordinator stops (no new
//      frames act, the dwell and the discovery pass are cancelled, the scheduler cancels its job
//      with `shutdown`), the panel channel stops, stdin stops being read; then the preflight
//      child is killed (`killPreflight()` is synchronous and runs before the first await).
//   2. `jobs`: the scheduler is stopped; every snapshot is released and every job token revoked
//      (a job's next read on agent.sock is refused); every adapter's job is aborted and its
//      process tree waited for (SIGTERM to the group → 2 s grace → SIGKILL → tracked descendants).
//   3. `parsers`: the parse worker is terminated.
//   4. `sockets`: core.sock and agent.sock close (connections' pins go with them).
//   5. `store`: the agent-profile lock is released and the agent token file removed, then the
//      capability store closes (its writes are already atomic).
//   6. `descendants`: any job descendant still tracked is SIGKILLed and waited for.
// The whole shutdown is bounded by SHUTDOWN_DEADLINE_MS (5 s), above the adapter's 2 s kill grace
// plus its reap; the Swift supervisor's hard stop (7 s) is the backstop beyond it. At the deadline
// the core logs `shutdown_deadline {pending}` and exits 0 anyway, after one last blocking ps sweep
// that SIGKILLs whatever tracked descendant is left (`shutdown_orphan {count}`; pids on stderr
// only, never arguments). The `shutdown` event carries the reason and each step's duration.
//
// At start, before agent.sock is published, every leftover `run/jobs/*` directory is removed (a
// hard-killed core leaves them; they hold no secrets, but a reused request id would refuse to
// launch): `jobs_swept {count}`; one that cannot be removed is logged and does not block start.

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { NATIVE_COMMAND_MAX_BYTES, NativeCommandSchema, type PanelState } from "@scout/contracts";
import type { AgentJobAdapter } from "./agents/adapter.js";
import { psSnapshot, type ProcessIdentity } from "./agents/processTree.js";
import type { JobScheduler } from "./jobScheduler.js";
import { createActivityStore } from "./activity/store.js";
import { createSnapshotRegistry, type SnapshotRegistry } from "./activity/snapshots.js";
import { createAgentAuth, type InteractiveTokenFile, writeInteractiveTokenFile } from "./agentApi/auth.js";
import { readBrowserContextGrant, writeBrowserContextGrant } from "./agentApi/grants.js";
import { createAgentHandlers } from "./agentApi/handlers.js";
import { createReadAudit, type ReadAudit } from "./agentApi/readAudit.js";
import { type AgentSocketServer, createAgentSocketServer } from "./agentSocketServer.js";
import { createSkillExporter, ExportError, type SkillExporter } from "./capabilities/exports.js";
import { type CapabilityStore, createCapabilityStore, StoreCorruptError } from "./capabilities/store.js";
import { StoreLockedError } from "./capabilities/storeLock.js";
import { createSiteResourceDiscoverer } from "./capabilities/discovery.js";
import { createCatalogCache } from "./catalog/cache.js";
import { createCatalogResolver } from "./catalog/resolveCatalog.js";
import { type Clock, systemClock } from "./clock.js";
import { ConfigError, type CoreConfig, readConfig } from "./config.js";
import { type Coordinator, createCoordinator } from "./coordinator.js";
import { createDiagnostics, defaultDiagnosticsPath, type Diagnostics, scoutHome } from "./diagnostics.js";
import { DWELL_MS } from "./dwell.js";
import { InstalledRecordError, readInstalledRecord } from "./installedRecord.js";
import { createPanelChannel, type PanelChannel } from "./panelChannel.js";
import { createResultRegistry } from "./results.js";
import { createSocketServer, SocketServerError } from "./socketServer.js";
import { createJobWiring, type JobWiring } from "./wiring/jobs.js";

/** Hard cap on shutdown: exit anyway if closing takes longer. */
export const SHUTDOWN_DEADLINE_MS = 5000;
/** How often the capability store collects garbage while the core runs (also once at start). */
export const GC_INTERVAL_MS = 60 * 60 * 1000;

/** The longest delay a Node timer holds; longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The dwell from SCOUT_DWELL_MS (tests only), or DWELL_MS when unset or invalid. */
export function dwellMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.SCOUT_DWELL_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return DWELL_MS;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMER_MS ? ms : DWELL_MS;
}

export const EXIT_OK = 0;
export const EXIT_START_FAILED = 1;
export const EXIT_USAGE = 2;

export interface StdioDeps {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Called once, after shutdown has finished or its deadline passed. */
  exit: (code: number) => void;
  clock?: Clock;
  diagnostics?: Diagnostics;
  /** Tests only: called once agent.sock is listening, with what a test drives job snapshots through. */
  onAgentStarted?: (agent: { store: CapabilityStore; snapshots: SnapshotRegistry }) => void;
  /** Tests only: the job scheduler, once built. */
  onJobsStarted?: (jobs: { scheduler: JobScheduler; adapter: AgentJobAdapter | null }) => void;
}

export interface StdioCore {
  shutdown(reason: string): Promise<void>;
}

/** Start the core on the given streams. Resolves once the socket is listening. */
export async function runStdio(deps: StdioDeps): Promise<StdioCore> {
  const clock = deps.clock ?? systemClock;
  const home = scoutHome(deps.env);
  const diagnostics =
    deps.diagnostics ?? createDiagnostics({ path: defaultDiagnosticsPath(deps.env), clock, warn: deps.log });

  let config: CoreConfig;
  try {
    config = readConfig(home);
  } catch (e) {
    const code = e instanceof ConfigError ? e.code : "config-unreadable";
    deps.log(`scout-core: ${code}`);
    diagnostics.event("start_failed", { code });
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }

  const runDir = join(home, "run");
  const exporter = openExporter(home, diagnostics);

  // The agent socket is built once the token exists; the store's revocation hook reaches it then.
  let agentServer: AgentSocketServer | null = null;
  // Built with the agent auth; job snapshots exist only once agent.sock can serve them.
  let snapshots: SnapshotRegistry | null = null;
  // Built after the store and the coordinator's inputs; the store's revocation hook and the grant frames reach it then.
  let jobs: JobWiring | null = null;
  let store: CapabilityStore;
  try {
    store = await createCapabilityStore({
      scoutHome: home,
      clock,
      diagnostics,
      onRevoked: (resourceId) => {
        // agent.sock first: it releases the snapshots that pinned the resource.
        agentServer?.resourceRevoked(resourceId);
        jobs?.scheduler.onResourceRevoked(resourceId);
      },
      ...(exporter ? { syncExports: (state) => exporter.sync(state) } : {}),
    });
  } catch (e) {
    const code =
      e instanceof StoreCorruptError ? `capability-store-${e.code}` : e instanceof StoreLockedError ? "capability-store-locked" : "capability-store-unreadable";
    deps.log(`scout-core: ${code}`);
    diagnostics.event("start_failed", { code });
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }
  // Built below, after the store; GC runs before then only at start, with nothing to sweep.
  let panel: PanelChannel | null = null;
  const collectGarbage = (): void => {
    // Expired read cursors and job snapshots would otherwise keep their pins.
    agentServer?.sweepExpired();
    snapshots?.sweepExpired();
    panel?.sweepExpired();
    void store.collectGarbage().catch(() => diagnostics.event("capability_gc_failed", {}));
  };
  collectGarbage();
  const gcTimer = setInterval(collectGarbage, GC_INTERVAL_MS);
  gcTimer.unref();

  let stdoutOpen = true;
  const emitPanel = (state: PanelState): void => {
    jobs?.observePanel(state);
    if (!stdoutOpen) return;
    deps.stdout.write(`${JSON.stringify(state)}\n`);
  };

  // Context reads over agent.sock; each one re-sends Scout's window its (debounced) audit view.
  const readAudit = createReadAudit();
  const audit: ReadAudit = {
    record(entry) {
      readAudit.record(entry);
      panel?.auditChanged();
    },
    entries: () => readAudit.entries(),
  };

  // One id per start, shared by agent.sock replies and Scout's window's capabilities frames.
  const coreInstanceId = randomBytes(16).toString("hex");

  // The registry and the channel read the coordinator's grants and visit lazily: they are
  // first used after both exist.
  const results = createResultRegistry({
    coreInstanceId,
    activeVisit: () => {
      if (coordinator.stopped) return null;
      const view = coordinator.agentView();
      if (view.paused || view.currentSite === null) return null;
      return { visitEpoch: view.currentSite.visitEpoch, origin: view.currentSite.origin };
    },
    isPermitted: (origin) => coordinator.permissions.isPermitted(origin),
    diagnostics,
  });
  panel = createPanelChannel({
    store,
    coreInstanceId,
    exportConflicts: () => exporter?.manifest().conflicts ?? [],
    readBrowserContextGrant: () => readBrowserContextGrant(home),
    writeBrowserContextGrant: (enabled) => writeBrowserContextGrant(home, enabled),
    getAudit: () => audit.entries(),
    isPermitted: (origin) => coordinator.permissions.isPermitted(origin),
    currentOrigin: () => coordinator.agentView().currentSite?.origin ?? null,
    emit: emitPanel,
    results,
    resendState: () => coordinator.resendState(),
    clock,
    diagnostics,
  });
  const panelChannel = panel;

  const activity = createActivityStore({ clock });
  // The adapter, preflight, parse pool and scheduler; it reads the coordinator only once a job runs.
  const jobWiring = createJobWiring({
    home,
    env: deps.env,
    destinations: config.destinations,
    coreInstanceId,
    clock,
    diagnostics,
    results,
    snapshots: () => snapshots,
    coordinator: () => coordinator,
    activity,
    store,
  });
  jobs = jobWiring;
  const scheduler = jobWiring.scheduler;
  // Settled visits run the same catalog and discovery pipelines as the dev CLI, with their
  // caches under SCOUT_HOME; the coordinator owns each pass's fetch session and window. Catalog
  // files are parsed in the parse worker; cancelling a pass's session cancels its parse.
  // Each pass resolves with its own session's parsers, which refuse work once the pass is cancelled.
  const resolveCatalog = (origin: string, session: Parameters<JobWiring["parsersFor"]>[0]) =>
    createCatalogResolver({ scoutHome: home, clock, diagnostics, parsers: jobWiring.parsersFor(session) }).resolve(origin, { session });
  const discoverer = createSiteResourceDiscoverer({ scoutHome: home, clock, diagnostics });
  const coordinator: Coordinator = createCoordinator({
    config,
    clock,
    diagnostics,
    emitPanel,
    dwellMs: dwellMsFromEnv(deps.env),
    onShutdownRequested: () => void shutdown("shutdown-command"),
    activity,
    onPause: () => snapshots?.releaseAll("paused"),
    capabilities: {
      store,
      createFetchSession: (origin) => jobWiring.createFetchSession(origin),
      resolveCatalog,
      discover: (origin, session) => discoverer.discover(origin, { session }),
    },
    panel: panelChannel,
    results,
    jobs: scheduler,
  });
  deps.onJobsStarted?.({ scheduler, adapter: jobWiring.adapter });
  panelChannel.start();
  // The startup export sync may record conflicts the first frame could not show.
  void store.startupExportSync.then(() => panelChannel.capabilitiesChanged());

  const server = createSocketServer({
    runDir,
    onClient: (client) => coordinator.attachClient(client),
    diagnostics,
  });
  let tokenFile: InteractiveTokenFile | null = null;

  // ---------- shutdown (see the header) ----------
  const stepMs: Record<string, number> = {};
  const pendingSteps = new Set<string>();
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    pendingSteps.add(name);
    const t = Date.now();
    try {
      await fn();
    } catch {
      diagnostics.event("shutdown_step_failed", { step: name });
    } finally {
      stepMs[name] = Date.now() - t;
      pendingSteps.delete(name);
    }
  };
  let orphans: ProcessIdentity[] = [];
  let closing: Promise<void> | null = null;
  /** Steps 2-6; `deadlineAt` (Date.now() time) bounds the descendant wait. */
  const closeAll = (deadlineAt: number): Promise<void> =>
    (closing ??= (async () => {
      clearInterval(gcTimer);
      await step("jobs", async () => {
        jobWiring.stopScheduler();
        // No job reads past shutdown, even on a connection agent.sock has not closed yet.
        snapshots?.releaseAll("shutdown");
        await jobWiring.abortJobs();
      });
      await step("parsers", () => jobWiring.closeParsers());
      await step("sockets", () => Promise.all([server.close(), agentServer?.close()]));
      await step("store", async () => {
        // The lock and the token first: a store close that hangs must not leave them behind.
        jobWiring.releaseProfile();
        tokenFile?.remove();
        await store.close();
      });
      await step("descendants", async () => {
        orphans = await jobWiring.reapDescendants(deadlineAt - FINAL_SWEEP_RESERVE_MS);
      });
    })());

  /** A last blocking look at the job trees: SIGKILL and report whatever is still alive. */
  const finalSweep = (): void => {
    if (jobWiring.processes.size === 0) return;
    const snap = psSnapshot();
    const left = jobWiring.processes.alive(snap);
    if (left.length === 0) return;
    for (const p of left) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    diagnostics.event("shutdown_orphan", { count: left.length });
    deps.log(`scout-core: shutdown_orphan pids ${left.map((p) => p.pid).join(",")}`);
  };

  // The only writer is the native app that launched us over a private pipe. Its commands fit
  // one atomic pipe write (shorter than NATIVE_COMMAND_MAX_BYTES with the newline, the app's own
  // limit); a longer line is refused like any invalid one. readline itself does not cap a line.
  // readline strips the newline, so it is added back to the count.
  const rl = createInterface({ input: deps.stdin, crlfDelay: Infinity });
  let shuttingDown: Promise<void> | null = null;
  // Settles (never rejects) once start has finished either way, so a shutdown that
  // arrives mid-bind closes the listeners that bind is about to produce.
  let startSettled: Promise<void> = Promise.resolve();
  /** Step 1: stop accepting work, then kill the preflight. Synchronous. */
  const stopAccepting = (): void => {
    coordinator.stop();
    panelChannel.stop();
    rl.close();
    // Before anything is awaited: a preflight child blocked on `claude` must never hold the exit.
    jobWiring.killPreflight();
  };
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    // Claim shutdown before rl.close(): it emits "close" synchronously, which would
    // otherwise re-enter here as a second, stdin-closed shutdown with its own exit.
    let finished!: () => void;
    shuttingDown = new Promise<void>((resolve) => (finished = resolve));
    const began = Date.now();
    const deadlineAt = began + SHUTDOWN_DEADLINE_MS;
    const t = Date.now();
    stopAccepting();
    stepMs.stop = Date.now() - t;
    diagnostics.event("shutdown_begin", { reason });
    deps.log(`scout-core: shutdown (${reason})`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), SHUTDOWN_DEADLINE_MS);
      timer.unref();
    });
    const closed = startSettled.then(() => closeAll(deadlineAt)).then(() => "closed" as const);
    void Promise.race([closed, deadline]).then((how) => {
      clearTimeout(timer);
      if (how === "deadline") diagnostics.event("shutdown_deadline", { pending: [...pendingSteps].join(",") || "start" });
      if (how === "deadline" || orphans.length > 0) finalSweep();
      const fields: Record<string, string | number> = { reason, totalMs: Date.now() - began };
      for (const [name, ms] of Object.entries(stepMs)) fields[`${name}Ms`] = ms;
      diagnostics.event("shutdown", fields);
      deps.exit(EXIT_OK);
      finished();
    });
    return shuttingDown;
  };

  let invalidLines = 0;
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = Buffer.byteLength(line, "utf8") + 1 < NATIVE_COMMAND_MAX_BYTES ? JSON.parse(line) : undefined;
    } catch {
      value = undefined;
    }
    const parsed = NativeCommandSchema.safeParse(value);
    if (!parsed.success) {
      invalidLines += 1;
      diagnostics.event("native_command_invalid", { count: invalidLines });
      return;
    }
    coordinator.handleNativeCommand(parsed.data);
  });
  // stdin closing means the app is gone: never outlive it.
  rl.on("close", () => void shutdown("stdin-closed"));
  rl.on("error", () => void shutdown("stdin-error"));
  deps.stdout.on("error", () => {
    stdoutOpen = false;
    void shutdown("stdout-error");
  });

  /** core.sock, then (once wrappers are reconciled) the token and agent.sock. Stops early when shutdown began. */
  const startSockets = async (): Promise<void> => {
    await server.start();
    await store.startupExportSync;
    if (shuttingDown !== null) return;
    // run/ exists and is private now; nothing has launched a job yet (no agent.sock, no snapshots).
    sweepJobDirs(join(runDir, "jobs"), diagnostics);
    try {
      tokenFile = writeInteractiveTokenFile(runDir);
    } catch {
      throw new StartError("agent-token-write-failed");
    }
    const auth = createAgentAuth({ interactiveToken: tokenFile.token, clock });
    const registry = createSnapshotRegistry({ store, auth, clock, diagnostics, paused: () => coordinator.agentView().paused });
    snapshots = registry;
    const handlers = createAgentHandlers({
      coreInstanceId,
      auth,
      store,
      view: () => coordinator.agentView(),
      catalog: createCatalogCache({ clock, dir: join(home, "cache", "catalog"), diagnostics }),
      browserContextGranted: () => readBrowserContextGrant(home),
      audit,
      clock,
      activity,
      getSnapshot: (jobId) => registry.getForJob(jobId),
    });
    agentServer = createAgentSocketServer({ runDir, handlers, auth, audit, diagnostics, snapshots: registry });
    try {
      await agentServer.start();
    } catch (e) {
      throw new StartError(`agent-${e instanceof SocketServerError ? e.code : "listen-failed"}`);
    }
    deps.onAgentStarted?.({ store, snapshots: registry });
  };

  const starting = startSockets();
  startSettled = starting.then(
    () => {},
    () => {},
  );
  try {
    await starting;
  } catch (e) {
    const code = e instanceof SocketServerError || e instanceof StartError ? e.code : "listen-failed";
    deps.log(`scout-core: socket server refused to start: ${code}`);
    diagnostics.event("start_failed", { code });
    // The app left while we were binding: shutdown already owns the exit.
    if (shuttingDown !== null) return { shutdown };
    // Claim shutdown first: rl.close() emits "close" synchronously, and that must not
    // start a second, stdin-closed shutdown with its own exit.
    shuttingDown = Promise.resolve();
    stopAccepting();
    await closeAll(Date.now() + SHUTDOWN_DEADLINE_MS);
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }
  // stdin may have closed while the sockets were binding; that shutdown closes them.
  if (shuttingDown !== null) await shuttingDown;
  else deps.log(`scout-core: listening on ${server.socketPath} and ${join(runDir, "agent.sock")} (chromeBundleId ${config.chromeBundleId})`);
  return { shutdown };
}

/** Room left after the descendant wait for the last blocking sweep and the exit. */
const FINAL_SWEEP_RESERVE_MS = 250;

/**
 * Remove every leftover job dir (a hard-killed core leaves them; they hold no secrets). Never
 * follows a link out of the jobs root: an entry is removed as what it is. Reports
 * `jobs_swept {count}`; an entry that cannot be removed is reported and does not block start.
 */
export function sweepJobDirs(jobsRoot: string, diagnostics: Diagnostics): number {
  let entries: string[];
  try {
    if (!lstatSync(jobsRoot).isDirectory()) return 0;
    entries = readdirSync(jobsRoot);
  } catch {
    return 0; // no jobs root yet
  }
  let removed = 0;
  for (const name of entries) {
    try {
      rmSync(join(jobsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      diagnostics.event("jobs_sweep_failed", { code: (e as NodeJS.ErrnoException)?.code ?? "unknown" });
    }
  }
  if (entries.length > 0) diagnostics.event("jobs_swept", { count: removed });
  return removed;
}

class StartError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StartError";
  }
}

/**
 * The skill exporter for the skills root the installer recorded, or undefined when none is
 * recorded or the record or root is unusable (reported to diagnostics, never fatal).
 */
function openExporter(home: string, diagnostics: Diagnostics): SkillExporter | undefined {
  let skillsRoot: string | undefined;
  try {
    skillsRoot = readInstalledRecord(home).skillsRoot;
  } catch (e) {
    diagnostics.event("installed_record_invalid", { code: e instanceof InstalledRecordError ? e.code : "installed-unreadable" });
    return undefined;
  }
  if (skillsRoot === undefined) return undefined;
  try {
    return createSkillExporter({ scoutHome: home, skillsRoot, diagnostics });
  } catch (e) {
    diagnostics.event("skills_root_invalid", { code: e instanceof ExportError ? e.code : "unknown" });
    return undefined;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (!argv.includes("--stdio")) {
    process.stderr.write("usage: main.js --stdio\n");
    process.exit(EXIT_USAGE);
  }
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  let core: StdioCore | null = null;
  const pendingSignals: string[] = [];
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (core === null) pendingSignals.push(sig);
      else void core.shutdown(`signal:${sig}`);
    });
  }
  core = await runStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => void process.stderr.write(`${line}\n`),
    exit,
  });
  const first = pendingSignals[0];
  if (first !== undefined) void core.shutdown(`signal:${first}`);
}

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) void main();
