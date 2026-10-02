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
// Recommendation jobs (jobScheduler.ts) run the user's agent (agents/claudeJob.ts) through the
// profile in `agent-profile.json`; without a usable profile every job is `unavailable`. The
// billing preflight runs off the event loop (agents/preflightWorker.ts), started once at start;
// jobs wait for it. Catalog parsing runs in a one-thread parse worker (catalog/parseWorker.ts)
// that a cancelled discovery pass cancels too. The scheduler hears the browser-context grant
// through the `grant` frames the panel channel emits (the same signal the window gets), and
// revoked resources through the store's revocation hook, after agent.sock released the
// snapshots that pinned them.
//
// Shutdown order: the coordinator stops (its scheduler cancels the running job with
// `shutdown`), then `adapter.abortAll()` waits for the job's process tree, then every snapshot
// is released and the sockets close. The whole close is still bounded by
// SHUTDOWN_DEADLINE_MS (2 s), which is the adapter's kill grace: a job that ignores SIGTERM may
// outlive the core by that grace (P3.4 raises the deadline).
//
// The process exits 0 when stdin closes (the app quit or crashed), on SIGTERM/SIGINT/
// SIGHUP, or on a `shutdown` command, after closing both sockets (which releases the agent
// connections' pins), then the store, then removing the token file. It never outlives the
// app by more than SHUTDOWN_DEADLINE_MS.

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { NATIVE_COMMAND_MAX_BYTES, NativeCommandSchema, type PanelState } from "@scout/contracts";
import type { AgentJobAdapter } from "./agents/adapter.js";
import { createClaudeJobAdapter, type ClaudeJobAdapter } from "./agents/claudeJob.js";
import { createPreflightFacade } from "./agents/preflightWorker.js";
import { AgentProfileError, loadAgentProfile, type AgentProfile } from "./agents/profile.js";
import { createParsePool } from "./catalog/parseWorker.js";
import { verifyTargets } from "./catalog/verifyTargets.js";
import { createJobScheduler, type JobScheduler } from "./jobScheduler.js";
import type { JobAnswer } from "./pipeline.js";
import { createJobResumeCache } from "./resumeCache.js";
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
import { createOriginFetchSession } from "./fetch/originSession.js";
import { InstalledRecordError, readInstalledRecord } from "./installedRecord.js";
import { createPanelChannel, type PanelChannel } from "./panelChannel.js";
import { createResultRegistry } from "./results.js";
import { createSocketServer, SocketServerError } from "./socketServer.js";

/** Hard cap on shutdown: exit anyway if closing takes longer. */
export const SHUTDOWN_DEADLINE_MS = 2000;
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
  let scheduler: JobScheduler | null = null;
  let store: CapabilityStore;
  try {
    store = await createCapabilityStore({
      scoutHome: home,
      clock,
      diagnostics,
      onRevoked: (resourceId) => {
        // agent.sock first: it releases the snapshots that pinned the resource.
        agentServer?.resourceRevoked(resourceId);
        scheduler?.onResourceRevoked(resourceId);
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
  // The browser-context grant as the window was last told it; every change bumps the revision
  // job requests carry and reaches the scheduler.
  let shownGrant: boolean | null = null;
  let grantRevision = 0;
  const emitPanel = (state: PanelState): void => {
    if (state.type === "grant" && state.agentBrowserContext !== shownGrant) {
      const first = shownGrant === null;
      shownGrant = state.agentBrowserContext;
      if (!first) {
        grantRevision += 1;
        scheduler?.onGrantChanged(state.agentBrowserContext);
      }
    }
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

  // Settled visits run the same catalog and discovery pipelines as the dev CLI, with their
  // caches under SCOUT_HOME; the coordinator owns each pass's fetch session and window. Catalog
  // files are parsed in the parse worker; cancelling a pass's session cancels its parse.
  const parsePool = createParsePool({ diagnostics });
  const catalogResolver = createCatalogResolver({ scoutHome: home, clock, diagnostics, parsers: parsePool.parsers });
  const discoverer = createSiteResourceDiscoverer({ scoutHome: home, clock, diagnostics });
  const activity = createActivityStore({ clock });

  const agentProfile = openAgentProfile(home, diagnostics);
  const adapter: ClaudeJobAdapter | null =
    agentProfile === null
      ? null
      : createClaudeJobAdapter({ home, profile: agentProfile, parentEnv: deps.env, preflightAsync: createPreflightFacade(), clock, diagnostics });
  // Off the event loop; the first job waits for it.
  void adapter?.refreshPreflightAsync();
  const jobs = createJobScheduler({
    coreInstanceId,
    clock,
    diagnostics,
    destinations: config.destinations,
    results,
    snapshots: () => snapshots,
    view: {
      visit: () => (coordinator.stopped || coordinator.agentView().paused ? null : coordinator.tracker.current()),
      permissionsRevision: () => coordinator.permissions.revision,
      isPermitted: (origin) => coordinator.permissions.isPermitted(origin),
      captureAllowed: () => coordinator.captureAllowed(),
    },
    window: {
      working: (visitEpoch, jobId) => coordinator.showWorking(visitEpoch, jobId),
      idle: (visitEpoch) => coordinator.showIdle(visitEpoch),
    },
    activity: () => activity.entries(),
    browserContextGranted: () => readBrowserContextGrant(home),
    grantRevision: () => grantRevision,
    approvalRevision: () => store.approvalRevision,
    agent: adapter,
    profile: {
      fingerprint: adapter?.profileFingerprint ?? "none",
      toolsRevision: agentProfile?.tools?.revision ?? 0,
      hasUserTools: (agentProfile?.tools?.selections.length ?? 0) > 0,
    },
    socketPath: join(runDir, "agent.sock"),
    verify: (candidates, o) => verifyTargets(candidates, { origin: o.origin, budgetMs: o.budgetMs, clock: o.clock }),
    resumeCache: createJobResumeCache<JobAnswer>({ clock, diagnostics }),
  });
  scheduler = jobs;
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
      createFetchSession: (origin) => {
        const session = createOriginFetchSession({ origin, clock });
        return {
          ...session,
          cancel: () => {
            session.cancel();
            parsePool.cancel();
          },
        };
      },
      resolveCatalog: (origin, session) => catalogResolver.resolve(origin, { session }),
      discover: (origin, session) => discoverer.discover(origin, { session }),
    },
    panel: panelChannel,
    results,
    jobs,
  });
  deps.onJobsStarted?.({ scheduler: jobs, adapter });
  panelChannel.start();
  // The startup export sync may record conflicts the first frame could not show.
  void store.startupExportSync.then(() => panelChannel.capabilitiesChanged());

  const server = createSocketServer({
    runDir,
    onClient: (client) => coordinator.attachClient(client),
    diagnostics,
  });
  let tokenFile: InteractiveTokenFile | null = null;

  // Sockets first (their connections' pins go with them), then the store, then the token.
  let closing: Promise<void> | null = null;
  const closeAll = (): Promise<void> =>
    (closing ??= (async () => {
      clearInterval(gcTimer);
      // The scheduler already cancelled its job (`shutdown`); wait for the job's process tree.
      jobs.stop();
      await adapter?.abortAll();
      void parsePool.close();
      // No job reads past shutdown, even on a connection agent.sock has not closed yet.
      snapshots?.releaseAll("shutdown");
      await Promise.all([server.close(), agentServer?.close()]);
      await store.close();
      tokenFile?.remove();
    })());

  // The only writer is the native app that launched us over a private pipe. Its commands fit
  // one atomic pipe write (shorter than NATIVE_COMMAND_MAX_BYTES with the newline, the app's own
  // limit); a longer line is refused like any invalid one. readline itself does not cap a line.
  // readline strips the newline, so it is added back to the count.
  const rl = createInterface({ input: deps.stdin, crlfDelay: Infinity });
  let shuttingDown: Promise<void> | null = null;
  // Settles (never rejects) once start has finished either way, so a shutdown that
  // arrives mid-bind closes the listeners that bind is about to produce.
  let startSettled: Promise<void> = Promise.resolve();
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    // Claim shutdown before rl.close(): it emits "close" synchronously, which would
    // otherwise re-enter here as a second, stdin-closed shutdown with its own exit.
    let finished!: () => void;
    shuttingDown = new Promise<void>((resolve) => (finished = resolve));
    diagnostics.event("shutdown", { reason });
    deps.log(`scout-core: shutdown (${reason})`);
    coordinator.stop();
    panelChannel.stop();
    rl.close();
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref());
    const closed = startSettled.then(closeAll);
    void Promise.race([closed, deadline]).then(() => {
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
    coordinator.stop();
    panelChannel.stop();
    rl.close();
    await closeAll();
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }
  // stdin may have closed while the sockets were binding; that shutdown closes them.
  if (shuttingDown !== null) await shuttingDown;
  else deps.log(`scout-core: listening on ${server.socketPath} and ${join(runDir, "agent.sock")} (chromeBundleId ${config.chromeBundleId})`);
  return { shutdown };
}

class StartError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StartError";
  }
}

/** The agent profile, or null (reported to diagnostics) when it is missing or unusable: jobs are then `unavailable`. */
function openAgentProfile(home: string, diagnostics: Diagnostics): AgentProfile | null {
  try {
    return loadAgentProfile(home);
  } catch (e) {
    diagnostics.event("agent_profile_unavailable", { code: e instanceof AgentProfileError ? e.code : "profile: unreadable" });
    return null;
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
