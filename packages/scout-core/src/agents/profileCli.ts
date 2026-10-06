// `cli.js agent ...`: the setup CLI for the existing MCP tools Scout's background jobs may
// call. It reads and writes the `tools` part of `<SCOUT_HOME>/agent-profile.json`
// (toolProfile.ts); there is no tool editor in the native window in this version.
//
//   inspect <definition-file> [--allow-start]  review a stdio definition (backendDefinition.ts);
//       with --allow-start, read its binding files, start it once, list its tools, stop it, and
//       store them as inspected only. Without the flag nothing is read beyond the definition
//       and nothing starts (exit 3). Re-inspecting a known id updates it like `refresh`.
//   enable <id> <tool> --unattended-read [--required]  select one inspected tool, freezing
//       its reviewed description and schema, with the user's unattended-use declaration.
//   disable <id> <tool>                         remove a selection.
//   refresh <id> [--allow-start]                re-read the stored definition file and
//       re-inspect. A changed command, argv, cwd or environment source deselects every tool
//       of that connection (a fresh review); otherwise a selected tool that is missing or
//       whose schema hash changed is deselected. New tools are inspected only.
//   status [--json]                             per connection: command drift, each env
//       source and whether its binding resolves now, inspected tools, and each selection's
//       compatibility under the bridge's drop rule (selectedToolDropReason) applied to the
//       last inspection. A connection whose binary changed or is missing is unavailable
//       (`binary_changed` / `binary_missing`) and its selections read `needs_review` until a
//       refresh. Nothing starts.
//
// Every write holds `<SCOUT_HOME>/agent-profile.lock` (capabilities/storeLock.ts) for its
// read-modify-write and bumps `tools.revision` and the connection's `revision`. The running
// core holds the same lock for its lifetime, so while it runs, writes exit 2. When the
// profile changes, the core cancels the running job and drops cached results
// (wiring/profileWatcher.ts).
//
// Output never carries an environment value: the profile stores bindings (`{file, pointer}`)
// and non-secret literals only, resolved values live in memory for the one spawn, and
// errors are field paths and fixed codes. Backend- and user-provided names, paths and argv
// entries are printed with control characters replaced. An argv entry that looks like it
// carries a secret draws a warning (argv is stored in the profile and visible to other
// processes); it is not refused.
//
// An auth prompt makes the connection unavailable: Scout never opens a hidden login flow.
// When the backend makes any request of Scout during inspection (inspectBackend's
// `auth_prompt`), the command prints the reason and exits 1, and stores nothing from that
// inspection. For a new connection that is all. For a known one (`refresh`, or `inspect` of
// a known id) its last stored inspection is left as it was, every selection on it is
// deselected, and the connection's `unavailable` field records the code, all in one profile
// write (revisions bumped).
// `status` reports it unavailable with that reason and `enable` refuses it until an
// inspection succeeds, which replaces the connection without the field.
//
// Exit codes: 0 ok, 1 usage / validation / unavailable, 2 locked, 3 needs --allow-start.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { StoreLockedError, acquireStoreLock, type StoreLock } from "../capabilities/storeLock.js";
import { scoutHome } from "../diagnostics.js";
import { commandDrift, inspectBackend, INSPECT_DEFAULT_LIMITS, loadBackendDefinition, SECRET_NAME_RE, type BackendDefinition, type CommandDrift, type InspectLimits, type InspectOutcome } from "./backendDefinition.js";
import { selectedToolDropReason, type BridgeDropCode } from "./contextToolBridge.js";
import { BINDING_STATUS_TEXT, checkEnvBindings, resolveBackendEnv, type BindingStatus } from "./environmentBindings.js";
import { AGENT_PROFILE_LOCK_FILE, AgentProfileError, loadAgentProfile, PROFILE_MAX_BYTES, writeAgentProfile, type AgentProfile } from "./profile.js";
import { createDefaultAgentProfile } from "./registry.js";
import { canonicalJson, MAX_CONNECTIONS, MAX_INSPECTED_TOOLS, MAX_SELECTIONS, type Connection, type ToolSelection, type ToolsProfile } from "./toolProfile.js";

/**
 * Why `status` reports a connection unavailable, when there is a single reason. Fixed codes:
 * `auth_prompt` is stored in the profile (Connection.unavailable); the binary codes are
 * computed by `status` only.
 */
export type UnavailableReason = NonNullable<Connection["unavailable"]>["reason"] | "binary_changed" | "binary_missing";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_LOCKED = 2;
const EXIT_NEEDS_START = 3;

export const AGENT_USAGE = `  cli.js agent inspect <definition-file> [--allow-start]
  cli.js agent enable <connection-id> <tool-name> --unattended-read [--required]
  cli.js agent disable <connection-id> <tool-name>
  cli.js agent refresh <connection-id> [--allow-start]
  cli.js agent status [--json]
`;

export interface AgentCliDeps {
  now?: () => number;
  /** Test seam for every ownership check (definition and binding files). */
  getuid?: () => number;
  inspectLimits?: InspectLimits;
}

export interface AgentCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  deps?: AgentCliDeps;
}

/** Backend- or file-provided text, safe for a terminal line. */
const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}]+/gu, " ");
const short = (hash: string | undefined): string => (hash ? hash.slice(0, 16) : "-");
/** An argv for a terminal line: each entry quoted, control characters replaced. */
const argv = (args: readonly string[]): string => args.map((a) => JSON.stringify(clean(a))).join(" ") || "(none)";
const SECRET_FLAG_RE = /--(token|key|password|secret)/i;

export async function agentCommand(args: readonly string[], io: AgentCliIo): Promise<number> {
  const usage = (): number => {
    io.stderr(AGENT_USAGE);
    return EXIT_FAIL;
  };
  const [sub, ...rest] = args;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const only = (...names: string[]): boolean => [...flags].every((f) => names.includes(f));
  const ctx = new Ctx(io);

  switch (sub) {
    case "inspect":
      if (positional.length !== 1 || !only("--allow-start")) return usage();
      return reviewAndInspect(ctx, resolve(positional[0]!), flags.has("--allow-start"), undefined);
    case "refresh": {
      if (positional.length !== 1 || !only("--allow-start")) return usage();
      const loaded = ctx.load();
      if (!loaded.ok) return loaded.code;
      const conn = loaded.profile?.tools?.connections.find((c) => c.id === positional[0]);
      if (!conn?.definitionFile) return ctx.fail(`refresh: no inspected connection "${clean(positional[0]!)}"; run agent inspect <definition-file> first`);
      return reviewAndInspect(ctx, conn.definitionFile, flags.has("--allow-start"), conn.id);
    }
    case "enable":
      if (positional.length !== 2 || !only("--unattended-read", "--required")) return usage();
      if (!flags.has("--unattended-read")) {
        return ctx.fail(
          "enable: --unattended-read is required. It is your declaration that this tool only reads and is safe for Scout's background jobs to call without asking you; Scout does not verify it.",
        );
      }
      return enable(ctx, positional[0]!, positional[1]!, flags.has("--required"));
    case "disable":
      if (positional.length !== 2 || flags.size > 0) return usage();
      return disable(ctx, positional[0]!, positional[1]!);
    case "status":
      if (positional.length !== 0 || !only("--json")) return usage();
      return status(ctx, flags.has("--json"));
    default:
      return usage();
  }
}

// ---------- shared plumbing ----------

class Ctx {
  readonly home: string;
  readonly now: () => number;
  readonly fs: { getuid?: () => number };
  readonly limits: InspectLimits;
  constructor(readonly io: AgentCliIo) {
    this.home = scoutHome(io.env ?? process.env);
    this.now = io.deps?.now ?? Date.now;
    this.fs = io.deps?.getuid ? { getuid: io.deps.getuid } : {};
    this.limits = io.deps?.inspectLimits ?? INSPECT_DEFAULT_LIMITS;
  }
  out(line = ""): void {
    this.io.stdout(`${line}\n`);
  }
  fail(line: string, code = EXIT_FAIL): number {
    this.io.stderr(`${line}\n`);
    return code;
  }
  /** The profile, or undefined when there is none yet. */
  load(): { ok: true; profile: AgentProfile | undefined } | { ok: false; code: number } {
    try {
      return { ok: true, profile: loadAgentProfile(this.home) };
    } catch (e) {
      if (e instanceof AgentProfileError && e.code === "profile: missing") return { ok: true, profile: undefined };
      return { ok: false, code: this.fail(e instanceof AgentProfileError ? e.code : "profile: unreadable") };
    }
  }
  /** Run `fn` holding the profile lock; exit 2 when another process holds it. */
  async locked(fn: () => Promise<number> | number): Promise<number> {
    let lock: StoreLock;
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      lock = acquireStoreLock(this.home, { now: this.now, file: AGENT_PROFILE_LOCK_FILE });
    } catch (e) {
      if (!(e instanceof StoreLockedError)) throw e;
      return this.fail("the agent profile is locked by another process (the Scout core holds it while it runs); quit Scout and retry", EXIT_LOCKED);
    }
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
  /** Validate the size the loader accepts, then write atomically. */
  write(profile: AgentProfile): number | undefined {
    if (Buffer.byteLength(JSON.stringify(profile, null, 2) + "\n", "utf8") > PROFILE_MAX_BYTES) {
      return this.fail(`the agent profile would exceed ${PROFILE_MAX_BYTES / 1024} KiB; remove a connection or select fewer tools`);
    }
    writeAgentProfile(this.home, profile);
    return undefined;
  }
}

/** Bump the tool configuration's and one connection's revision. */
function bump(tools: ToolsProfile, connectionId: string): number {
  tools.revision = (tools.revision ?? 0) + 1;
  for (const c of tools.connections) if (c.id === connectionId) c.revision = (c.revision ?? 0) + 1;
  return tools.revision;
}

const launchFields = (c: Pick<Connection, "command" | "args" | "env" | "literalEnv" | "cwd">): string =>
  canonicalJson({ command: c.command, args: c.args, env: c.env, literalEnv: c.literalEnv ?? {}, cwd: c.cwd ?? "/" });

// ---------- inspect / refresh ----------

function printProposal(ctx: Ctx, def: BackendDefinition): void {
  const c = def.connection;
  ctx.out(`connection   ${c.id}`);
  ctx.out(`command      ${clean(c.command)}`);
  ctx.out(`resolves to  ${clean(def.resolvedCommand.path)}`);
  ctx.out(`args         ${argv(c.args)}`);
  c.args.forEach((a, i) => {
    if (SECRET_NAME_RE.test(a) || SECRET_FLAG_RE.test(a)) {
      ctx.io.stderr(`warning: argument ${i + 1} looks like it may name or carry a secret. Arguments are stored in the agent profile and other processes can see them; put secrets in env (a 0600 definition file or a binding) instead.\n`);
    }
  });
  ctx.out(`cwd          ${clean(c.cwd ?? "/")}`);
  ctx.out(`definition   ${clean(def.file)} (${def.private ? "mode 0600: literal values stay in this file and are read at launch" : "readable by others: its literals are copied into the profile; chmod 600 it to keep them there"})`);
  if (def.envEntries.length === 0) ctx.out("env          (none: the backend gets an empty environment)");
  for (const e of def.envEntries) {
    const how = e.kind === "binding" ? `from ${clean(e.file)} at ${clean(e.pointer)}` : e.kind === "literal_in_definition" ? "literal, kept in the definition file" : "literal, copied into the profile";
    ctx.out(`env          ${e.name}  ${how}`);
  }
  ctx.out("             The backend gets only these variables: nothing from this shell, login or Finder environment.");
  if (def.filesRead.length > 0) ctx.out(`reads        ${def.filesRead.map(clean).join(", ")}`);
}

async function reviewAndInspect(ctx: Ctx, file: string, allowStart: boolean, refreshId: string | undefined): Promise<number> {
  const loaded = loadBackendDefinition(file, ctx.fs);
  if (!loaded.ok) {
    for (const e of loaded.errors) ctx.io.stderr(`${e}\n`);
    return EXIT_FAIL;
  }
  const def = loaded.definition;
  if (refreshId !== undefined && def.connection.id !== refreshId) return ctx.fail(`refresh: the definition file now names connection "${clean(def.connection.id)}", not "${clean(refreshId)}"; inspect it as a new connection`);
  printProposal(ctx, def);
  if (!allowStart) return ctx.fail("not started. Re-run with --allow-start to read the files listed above and start this command once to list its tools.", EXIT_NEEDS_START);

  return ctx.locked(async () => {
    const loadedProfile = ctx.load();
    if (!loadedProfile.ok) return loadedProfile.code;
    let profile = loadedProfile.profile;
    if (!profile) {
      try {
        profile = createDefaultAgentProfile(ctx.io.env ?? process.env);
      } catch (e) {
        return ctx.fail(e instanceof AgentProfileError ? `${e.code}: the agent profile needs it; install it or put it on PATH` : "profile: could not be created");
      }
    }
    const tools: ToolsProfile = profile.tools ?? { connections: [], selections: [] };
    const prev = tools.connections.find((c) => c.id === def.connection.id);
    if (refreshId !== undefined && !prev) return ctx.fail(`refresh: connection "${refreshId}" is gone`);
    if (!prev && tools.connections.length >= MAX_CONNECTIONS) return ctx.fail(`inspect: at most ${MAX_CONNECTIONS} connections`);

    const env = resolveBackendEnv(def.connection, ctx.fs);
    if (!env.ok) {
      for (const f of env.failures) ctx.io.stderr(`env ${f.name}: ${BINDING_STATUS_TEXT[f.status]} (${clean(f.file)} at ${clean(f.pointer)})\n`);
      return ctx.fail("connection unavailable: not started");
    }
    const outcome = await inspectBackend(def.connection, env.env, ctx.limits);
    if (!outcome.ok) {
      if (outcome.reason === "auth_prompt") return markAuthPrompt(ctx, profile, tools, prev);
      const why = { did_not_start: "did not start or did not answer MCP initialize", timed_out: "did not answer in time", list_failed: "did not list its tools" }[outcome.reason];
      return ctx.fail(`connection unavailable: the backend ${why}; stopped`);
    }

    const { deselected, added, definitionChanged } = applyInspection(tools, def, outcome, prev, new Date(ctx.now()).toISOString());
    const revision = bump(tools, def.connection.id);
    profile.tools = tools;
    const wrote = ctx.write(profile);
    if (wrote !== undefined) return wrote;

    ctx.out();
    ctx.out(`listed ${outcome.tools.length} tool(s)${outcome.skipped ? `, ${outcome.skipped} skipped (unusable name, duplicate, or over ${MAX_INSPECTED_TOOLS})` : ""}${outcome.truncated ? `, ${outcome.truncated} description(s) cut to 1024 characters` : ""}:`);
    for (const t of outcome.tools) {
      const desc = clean(t.description).trim();
      ctx.out(`  ${clean(t.name)}  schema ${short(t.schemaHash)}${t.unselectable ? `  (cannot be selected: ${t.unselectable})` : ""}${added.includes(t.name) ? "  NEW" : ""}`);
      if (desc) ctx.out(`      ${desc.length > 160 ? `${desc.slice(0, 157)}...` : desc}`);
    }
    if (definitionChanged) ctx.out("the command, arguments, cwd or environment sources changed: every tool of this connection needs selecting again");
    for (const d of deselected) ctx.out(`deselected ${clean(d.tool)}: ${d.reason}`);
    ctx.out(`profile revision ${revision}. Inspection enables nothing; select a tool with: cli.js agent enable ${def.connection.id} <tool-name> --unattended-read [--required]`);
    return EXIT_OK;
  });
}

const AUTH_PROMPT_TEXT = "the backend asked Scout for input while starting (sampling, elicitation or roots: a login or auth prompt?); Scout never answers one or opens a login flow";

/**
 * The backend made a request during inspection: store nothing from it. A known connection
 * keeps its last inspection, loses every selection and is marked unavailable, in one write.
 */
function markAuthPrompt(ctx: Ctx, profile: AgentProfile, tools: ToolsProfile, prev: Connection | undefined): number {
  ctx.io.stderr(`${AUTH_PROMPT_TEXT}; stopped\n`);
  if (!prev) return ctx.fail("connection unavailable (auth_prompt): nothing stored");
  const deselected = tools.selections.filter((s) => s.connectionId === prev.id).map((s) => s.toolName);
  tools.selections = tools.selections.filter((s) => s.connectionId !== prev.id);
  const unavailable = { reason: "auth_prompt", at: new Date(ctx.now()).toISOString() } as const;
  tools.connections = tools.connections.map((c) => (c.id === prev.id ? { ...c, unavailable } : c));
  const revision = bump(tools, prev.id);
  profile.tools = tools;
  const wrote = ctx.write(profile);
  if (wrote !== undefined) return wrote;
  for (const t of deselected) ctx.io.stderr(`deselected ${clean(t)}: connection_unavailable\n`);
  return ctx.fail(`connection unavailable (auth_prompt): its last inspection is kept but nothing can be selected until agent refresh ${prev.id} --allow-start succeeds; profile revision ${revision}`);
}

type DeselectReason = BridgeDropCode | "definition_changed";

/** Store the inspection in `tools` (mutated) and drop selections it invalidates. */
export function applyInspection(
  tools: ToolsProfile,
  def: BackendDefinition,
  outcome: Extract<InspectOutcome, { ok: true }>,
  prev: Connection | undefined,
  inspectedAt: string,
): { deselected: { tool: string; reason: DeselectReason }[]; added: string[]; definitionChanged: boolean } {
  const id = def.connection.id;
  const definitionChanged = prev !== undefined && launchFields(prev) !== launchFields(def.connection);
  const deselected: { tool: string; reason: DeselectReason }[] = [];
  tools.selections = tools.selections.filter((s) => {
    if (s.connectionId !== id) return true;
    const reason: DeselectReason | undefined = definitionChanged ? "definition_changed" : selectedToolDropReason({ name: s.toolName, schemaHash: s.schemaHash }, outcome.tools);
    if (reason) deselected.push({ tool: s.toolName, reason });
    return reason === undefined;
  });
  const known = new Set((prev?.inspectedTools ?? []).map((t) => t.name));
  const added = prev ? outcome.tools.map((t) => t.name).filter((n) => !known.has(n)) : [];
  // Built from the definition, not from `prev`: a successful inspection drops `unavailable`.
  const next: Connection = { ...def.connection, definitionFile: def.file, revision: prev?.revision ?? 0, resolvedCommand: def.resolvedCommand, inspectedAt, inspectedTools: outcome.tools };
  tools.connections = prev ? tools.connections.map((c) => (c.id === id ? next : c)) : [...tools.connections, next];
  return { deselected, added, definitionChanged };
}

// ---------- enable / disable ----------

async function enable(ctx: Ctx, id: string, toolName: string, required: boolean): Promise<number> {
  return ctx.locked(() => {
    const loaded = ctx.load();
    if (!loaded.ok) return loaded.code;
    const profile = loaded.profile;
    const tools = profile?.tools;
    const conn = tools?.connections.find((c) => c.id === id);
    if (!profile || !tools || !conn?.inspectedTools) return ctx.fail(`enable: connection "${clean(id)}" has not been inspected; run agent inspect <definition-file> --allow-start first`);
    const tool = conn.inspectedTools.find((t) => t.name === toolName);
    if (!tool) return ctx.fail(`enable: "${clean(toolName)}" was not listed by the last inspection of ${clean(id)}; run agent refresh ${clean(id)} --allow-start`);
    if (conn.unavailable) return ctx.fail(`enable: connection "${clean(id)}" is unavailable (${conn.unavailable.reason}); run agent refresh ${clean(id)} --allow-start`);
    if (!tool.inputSchema || !tool.schemaHash) return ctx.fail(`enable: "${clean(toolName)}" cannot be selected (${tool.unselectable ?? "no schema"})`);
    const drift = commandDrift(conn.command, conn.resolvedCommand);
    if (drift !== "same") return ctx.fail(`enable: the command is ${drift === "missing" ? "missing" : "not the binary that was inspected"}; run agent refresh ${clean(id)} --allow-start`);
    if (tools.selections.some((s) => s.toolName === toolName && s.connectionId !== id)) return ctx.fail(`enable: a tool named "${clean(toolName)}" is already selected on another connection; tool names must be unique`);
    const existing = tools.selections.findIndex((s) => s.toolName === toolName && s.connectionId === id);
    if (existing < 0 && tools.selections.length >= MAX_SELECTIONS) return ctx.fail(`enable: at most ${MAX_SELECTIONS} selected tools`);
    const selection: ToolSelection = {
      connectionId: id,
      toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      schemaHash: tool.schemaHash,
      required,
      unattendedReadDeclared: true,
      selectedAt: new Date(ctx.now()).toISOString(),
    };
    if (existing >= 0) tools.selections[existing] = selection;
    else tools.selections.push(selection);
    const revision = bump(tools, id);
    const wrote = ctx.write(profile);
    if (wrote !== undefined) return wrote;
    ctx.out(`enabled ${clean(toolName)} on ${clean(id)} (${required ? "required: a job does not run without it" : "optional"}), schema ${short(tool.schemaHash)}, command ${clean(conn.resolvedCommand!.path)}; profile revision ${revision}`);
    return EXIT_OK;
  });
}

async function disable(ctx: Ctx, id: string, toolName: string): Promise<number> {
  return ctx.locked(() => {
    const loaded = ctx.load();
    if (!loaded.ok) return loaded.code;
    const profile = loaded.profile;
    const tools = profile?.tools;
    const i = tools?.selections.findIndex((s) => s.connectionId === id && s.toolName === toolName) ?? -1;
    if (!profile || !tools || i < 0) return ctx.fail(`disable: "${clean(toolName)}" is not selected on "${clean(id)}"`);
    tools.selections.splice(i, 1);
    const revision = bump(tools, id);
    const wrote = ctx.write(profile);
    if (wrote !== undefined) return wrote;
    ctx.out(`disabled ${clean(toolName)} on ${clean(id)}; profile revision ${revision}. The Scout core cancels running jobs that use it when it sees the new revision.`);
    return EXIT_OK;
  });
}

// ---------- status ----------

export interface EnvSourceStatus {
  name: string;
  kind: "binding" | "literal";
  file?: string;
  pointer?: string;
  status?: BindingStatus;
}

export interface ConnectionStatus {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  definitionFile?: string;
  revision: number;
  inspectedAt?: string;
  resolvedCommand?: string;
  commandDrift: CommandDrift;
  available: boolean;
  /**
   * Set when one known cause makes the connection unavailable: an auth prompt at the last
   * inspection attempt, or a binary that changed or is missing since it. Binding problems
   * are reported per env source instead.
   */
  unavailableReason?: UnavailableReason;
  env: EnvSourceStatus[];
  inspectedTools: { name: string; schemaHash?: string; selectable: boolean }[];
  /** `needs_review`: the binary changed or is missing; refresh before relying on the selection. */
  selected: { tool: string; required: boolean; compatibility: "ok" | BridgeDropCode | "needs_review" }[];
}

export interface AgentStatus {
  profile: "missing" | "present";
  revision: number;
  connections: ConnectionStatus[];
}

/** The status report: names, paths, codes and hashes; never a value. */
export function agentStatus(profile: AgentProfile | undefined, fs: { getuid?: () => number } = {}): AgentStatus {
  const tools = profile?.tools;
  const connections = (tools?.connections ?? []).map((c): ConnectionStatus => {
    const checks = checkEnvBindings(c.env, fs);
    const drift = commandDrift(c.command, c.resolvedCommand);
    const binaryReason = drift === "missing" ? "binary_missing" : drift === "changed" ? "binary_changed" : undefined;
    const reason: UnavailableReason | undefined = c.unavailable?.reason ?? binaryReason;
    const available = reason === undefined && checks.every((b) => b.status === "ok");
    const listed = available ? (c.inspectedTools ?? []) : undefined;
    const s: ConnectionStatus = {
      id: c.id,
      command: c.command,
      args: [...c.args],
      cwd: c.cwd ?? "/",
      revision: c.revision ?? 0,
      commandDrift: drift,
      available,
      env: [...checks.map((b): EnvSourceStatus => ({ name: b.name, kind: "binding", file: b.file, pointer: b.pointer, status: b.status })), ...Object.keys(c.literalEnv ?? {}).map((name): EnvSourceStatus => ({ name, kind: "literal" }))],
      inspectedTools: (c.inspectedTools ?? []).map((t) => ({ name: t.name, ...(t.schemaHash ? { schemaHash: t.schemaHash } : {}), selectable: t.inputSchema !== undefined })),
      selected: (tools?.selections ?? [])
        .filter((sel) => sel.connectionId === c.id)
        .map((sel) => ({ tool: sel.toolName, required: sel.required, compatibility: binaryReason ? "needs_review" : (selectedToolDropReason({ name: sel.toolName, schemaHash: sel.schemaHash }, listed) ?? "ok") })),
    };
    if (reason) s.unavailableReason = reason;
    if (c.definitionFile) s.definitionFile = c.definitionFile;
    if (c.inspectedAt) s.inspectedAt = c.inspectedAt;
    if (c.resolvedCommand) s.resolvedCommand = c.resolvedCommand.path;
    return s;
  });
  return { profile: profile ? "present" : "missing", revision: tools?.revision ?? 0, connections };
}

function status(ctx: Ctx, json: boolean): number {
  const loaded = ctx.load();
  if (!loaded.ok) return loaded.code;
  const report = agentStatus(loaded.profile, ctx.fs);
  if (json) {
    ctx.out(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }
  if (report.profile === "missing") {
    ctx.out("no agent profile yet; agent inspect creates one");
    return EXIT_OK;
  }
  ctx.out(`profile revision ${report.revision}`);
  if (report.connections.length === 0) ctx.out("no connections: Scout's jobs use Scout's own tools only");
  for (const c of report.connections) {
    ctx.out();
    ctx.out(`connection   ${c.id}  (revision ${c.revision}${c.available ? "" : `, UNAVAILABLE${c.unavailableReason ? `: ${c.unavailableReason}` : ""}`})`);
    if (c.unavailableReason === "auth_prompt") ctx.out(`             ${AUTH_PROMPT_TEXT}. Run agent refresh ${c.id} --allow-start once it starts without one.`);
    ctx.out(`command      ${clean(c.command)}  binary ${c.commandDrift === "same" ? "unchanged since inspection" : c.commandDrift === "changed" ? "CHANGED since inspection (run agent refresh)" : c.commandDrift === "missing" ? "MISSING" : "not recorded"}`);
    ctx.out(`args         ${argv(c.args)}`);
    ctx.out(`cwd          ${clean(c.cwd)}`);
    if (c.definitionFile) ctx.out(`definition   ${clean(c.definitionFile)}`);
    if (c.inspectedAt) ctx.out(`inspected    ${c.inspectedAt}`);
    for (const e of c.env) {
      ctx.out(e.kind === "literal" ? `env          ${e.name}  literal in the profile` : `env          ${e.name}  ${clean(e.file!)} at ${clean(e.pointer!)}: ${BINDING_STATUS_TEXT[e.status!]}`);
    }
    ctx.out(`inspected    ${c.inspectedTools.length ? c.inspectedTools.map((t) => `${clean(t.name)}${t.selectable ? "" : " (not selectable)"}`).join(", ") : "(none)"}`);
    if (c.selected.length === 0) ctx.out("selected     (none)");
    for (const s of c.selected) ctx.out(`selected     ${clean(s.tool)}  ${s.required ? "required" : "optional"}  ${s.compatibility}`);
  }
  return EXIT_OK;
}
