#!/usr/bin/env node
// `pcm`: the personal-context service's command line. `runCli(argv, io)` is the testable
// core; importing this module does nothing, and the process entry runs it only when this
// file is argv[1].
//
// - `rank` is a plain MCP client of the running service (token from <home>/token).
// - `status` reads run/server.json and calls context_status.
// - `sources` lists the configured grants and counts readable files with the source
//   tools' own bounded walker. It never reads note contents; for a project registry it
//   reads only each note's frontmatter, as the source tools do, to find `repo:` projects.
// - `sources enable|disable` flips one grant in config.json; `reload` sends SIGHUP.
// Nothing here prints the token.

import { randomUUID } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ContextStatusSchema,
  MAX_CANDIDATE_DESCRIPTION_CHARS,
  MAX_CANDIDATE_TITLE_CHARS,
  MAX_CANDIDATES,
  MAX_DEADLINE_MS,
  MAX_LABEL_QUALITY_CHARS,
  MAX_RESULTS,
  MAX_SITE_NAME_CHARS,
  RankCandidateSchema,
  RankRequestSchema,
  RankResponseSchema,
  type RankCandidate,
  type RankRequest,
} from "./api.js";
import {
  ConfigError,
  loadConfig,
  readConfigFile,
  resolveConfig,
  resolveHome,
  sourceGrantRevision,
  writeConfig,
  type EnvLike,
  type ExclusionOptions,
  type SourceConfig,
} from "./config.js";
import { pidAlive, readServerInfo, readToken, ServiceFileError } from "./serviceFiles.js";
import { rootAvailability, walkFiles, type TreeOptions } from "./sourceTools/markdownDir.js";
import { discoverProjects } from "./sourceTools/registryProjects.js";

export const USAGE = `usage:
  pcm rank --origin <https-origin> --candidates <file.json> [--max-results 3] [--deadline-ms 20000] [--name <site name>]
  pcm status
  pcm sources
  pcm sources enable <id> [--project <name>]
  pcm sources disable <id> [--project <name>]
  pcm reload
  pcm --help

The candidates file is a JSON array of {id, title, description?, labelQuality}, or a Scout
catalog (the output of \`scout-core cli.js catalog <origin> --json\`, or a catalog cache file).
Exit codes: 0 ok; 1 misuse or service down; 2 a rank that is not ok/empty or could not run.
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: EnvLike;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_RANK = 2;
const MAX_CANDIDATES_FILE_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

class UsageError extends Error {}

/** `--flag value` pairs and positionals. A flag given twice or without a value is misuse. */
function parseArgs(argv: readonly string[], allowed: readonly string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (!allowed.includes(a) || flags.has(a)) throw new UsageError();
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError();
      flags.set(a, v);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function intFlag(v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) throw new UsageError();
  const n = Number(v);
  if (n < min || n > max) throw new UsageError();
  return n;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  const usage = (): number => {
    io.stderr(USAGE);
    return EXIT_FAIL;
  };
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  let home: string;
  try {
    home = resolveHome(env);
  } catch {
    io.stderr("PERSONAL_CONTEXT_HOME (or HOME) is not absolute\n");
    return EXIT_FAIL;
  }
  try {
    switch (cmd) {
      case "rank":
        return await rankCommand(rest, home, env, io);
      case "status":
        if (rest.length) return usage();
        return await statusCommand(home, io);
      case "sources":
        if (rest.length === 0) return sourcesList(home, env, io);
        if (rest[0] === "enable" || rest[0] === "disable") return sourcesToggle(rest[0] === "enable", rest.slice(1), home, env, io);
        return usage();
      case "reload":
        if (rest.length) return usage();
        return reloadCommand(home, io);
      default:
        return usage();
    }
  } catch (e) {
    if (e instanceof UsageError) return usage();
    if (e instanceof ConfigError) {
      io.stderr(`config: ${e.code}${e.field ? ` (${e.field})` : ""}\n`);
      return EXIT_FAIL;
    }
    if (e instanceof ServiceFileError) {
      io.stderr(`${e.message}\n`);
      return EXIT_FAIL;
    }
    io.stderr("pcm: unexpected failure\n");
    return EXIT_FAIL;
  }
}

// ---------- service connection ----------

/** The port a client should use: the running server's, else PCM_PORT, else the config's. */
function servicePort(home: string, env: EnvLike): number {
  const info = readServerInfo(home);
  if (info !== undefined && pidAlive(info.pid)) return info.port;
  if (env.PCM_PORT && /^\d{1,5}$/.test(env.PCM_PORT)) return Number(env.PCM_PORT);
  return loadConfig(home, env).port;
}

async function withClient<T>(home: string, port: number, fn: (client: Client) => Promise<T>): Promise<T> {
  const token = readToken(home);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "pcm", version: "0.0.0" });
  await client.connect(transport as Transport, { timeout: CONNECT_TIMEOUT_MS });
  try {
    return await fn(client);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

// ---------- rank ----------

function readBoundedFile(path: string, max: number): string {
  const fd = openSync(path, fsc.O_RDONLY | fsc.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a file");
    const buf = Buffer.alloc(max + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > max) throw new Error("too large");
    }
    return buf.subarray(0, len).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Candidates from a file: a RankCandidate array as-is, or a Scout catalog (`{candidates}`
 * from `catalog --json`, or a cache file's `{catalog: {candidates}}`) mapped to
 * `c1..cN` with its title, description and labelQuality. Undefined when neither.
 */
export function candidatesFromJson(value: unknown): RankCandidate[] | undefined {
  if (Array.isArray(value)) {
    const r = RankCandidateSchema.array().max(MAX_CANDIDATES).safeParse(value);
    return r.success ? r.data : undefined;
  }
  const catalog = isRec(value) && isRec(value.catalog) ? value.catalog : value;
  if (!isRec(catalog) || !Array.isArray(catalog.candidates)) return undefined;
  const out: RankCandidate[] = [];
  for (const entry of catalog.candidates.slice(0, MAX_CANDIDATES)) {
    if (!isRec(entry) || typeof entry.title !== "string") return undefined;
    const c: RankCandidate = {
      id: `c${out.length + 1}`,
      title: cut(entry.title, MAX_CANDIDATE_TITLE_CHARS),
      labelQuality: cut(typeof entry.labelQuality === "string" ? entry.labelQuality : "slug", MAX_LABEL_QUALITY_CHARS),
    };
    if (typeof entry.description === "string") c.description = cut(entry.description, MAX_CANDIDATE_DESCRIPTION_CHARS);
    out.push(c);
  }
  return out;
}

async function rankCommand(argv: readonly string[], home: string, env: EnvLike, io: CliIo): Promise<number> {
  const { flags, positional } = parseArgs(argv, ["--origin", "--candidates", "--max-results", "--deadline-ms", "--name"]);
  const origin = flags.get("--origin");
  const file = flags.get("--candidates");
  if (positional.length || origin === undefined || file === undefined) throw new UsageError();
  const maxResults = intFlag(flags.get("--max-results"), MAX_RESULTS, 1, MAX_RESULTS);
  const deadlineMs = intFlag(flags.get("--deadline-ms"), 20_000, 1, MAX_DEADLINE_MS);
  const name = flags.get("--name");
  if (name !== undefined && name.length > MAX_SITE_NAME_CHARS) throw new UsageError();

  let candidates: RankCandidate[] | undefined;
  try {
    candidates = candidatesFromJson(JSON.parse(readBoundedFile(file, MAX_CANDIDATES_FILE_BYTES)));
  } catch {
    candidates = undefined;
  }
  if (candidates === undefined) {
    io.stderr("candidates file is not a candidate array or a Scout catalog\n");
    return EXIT_FAIL;
  }
  const req: RankRequest = {
    requestId: randomUUID(),
    site: name === undefined ? { origin } : { origin, name },
    candidates,
    maxResults,
    deadlineMs,
  };
  if (!RankRequestSchema.safeParse(req).success) {
    io.stderr("origin must be an https origin (https://host[:port])\n");
    return EXIT_FAIL;
  }
  let result: unknown;
  try {
    result = await withClient(home, servicePort(home, env), (client) =>
      client.callTool({ name: "rank_site_links", arguments: req }, undefined, { timeout: deadlineMs + 15_000 }),
    );
  } catch (e) {
    if (e instanceof ServiceFileError || e instanceof ConfigError) throw e;
    io.stderr("service unreachable (is `node dist/server.js` running?)\n");
    return EXIT_RANK;
  }
  const parsed = RankResponseSchema.safeParse(isRec(result) ? result.structuredContent : undefined);
  if (!parsed.success) {
    io.stderr("service returned a malformed response\n");
    return EXIT_RANK;
  }
  io.stdout(`${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data.status === "ok" || parsed.data.status === "empty" ? EXIT_OK : EXIT_RANK;
}

// ---------- status / reload ----------

async function statusCommand(home: string, io: CliIo): Promise<number> {
  const info = readServerInfo(home);
  const alive = info !== undefined && pidAlive(info.pid);
  if (info === undefined || !alive) {
    io.stdout(info === undefined ? "service: not running\n" : `service: not running (stale run/server.json, pid ${info.pid})\n`);
    return EXIT_FAIL;
  }
  io.stdout(`service: running\npid: ${info.pid}\nport: ${info.port}\nstarted: ${info.startedAt}\n`);
  try {
    const res = await withClient(home, info.port, (client) => client.callTool({ name: "context_status", arguments: {} }));
    const parsed = ContextStatusSchema.safeParse(isRec(res) ? res.structuredContent : undefined);
    if (!parsed.success) {
      io.stderr("context_status: malformed response\n");
      return EXIT_FAIL;
    }
    io.stdout(`${JSON.stringify(parsed.data, null, 2)}\n`);
    return EXIT_OK;
  } catch (e) {
    if (e instanceof ServiceFileError) throw e;
    io.stderr("context_status: service unreachable\n");
    return EXIT_FAIL;
  }
}

function reloadCommand(home: string, io: CliIo): number {
  const info = readServerInfo(home);
  if (info === undefined || !pidAlive(info.pid)) {
    io.stderr("service: not running\n");
    return EXIT_FAIL;
  }
  try {
    process.kill(info.pid, "SIGHUP");
  } catch {
    io.stderr("service: could not signal the server process\n");
    return EXIT_FAIL;
  }
  io.stdout(`reload signalled (pid ${info.pid})\n`);
  return EXIT_OK;
}

// ---------- sources ----------

function exclusionFor(home: string, env: EnvLike): ExclusionOptions {
  const out: ExclusionOptions = {};
  if (env.HOME) out.home = env.HOME;
  if (env.PERSONAL_CONTEXT_HOME) out.serviceHome = home;
  return out;
}

function countLine(root: string, exclude: readonly string[], exclusion: ExclusionOptions): string {
  const tree: TreeOptions = { root, exclude, exclusion };
  const avail = rootAvailability(tree);
  if (!avail.ok) return `unavailable (${avail.code})`;
  const walked = walkFiles(tree);
  return `${walked.files.length}${walked.truncated ? "+" : ""} files`;
}

function describeSource(s: SourceConfig, exclusion: ExclusionOptions): string[] {
  const head = `${s.id}  ${s.kind}  ${s.enabled ? "enabled" : "disabled"}${"purpose" in s && s.purpose ? `  purpose=${s.purpose}` : ""}`;
  if (s.kind === "markdown_dir") return [head, `  root: ${s.root}`, `  ${countLine(s.root, s.exclude, exclusion)}`];
  if (s.kind === "focus_http") return [head, `  url: ${s.url}`];
  const lines = [head, `  registry: ${s.registry}`, `  subpath: ${s.subpath}`];
  const view = discoverProjects(s, { exclusion });
  if (view.availability !== "ok") {
    lines.push(`  registry unavailable (${view.availability})`);
    return lines;
  }
  if (view.projects.length === 0) lines.push("  projects: none found");
  for (const p of view.projects) {
    let line = `  project ${p.name}: ${p.enabled ? "enabled" : "disabled"}`;
    if (p.enabled) line += p.root !== undefined ? `, ${p.root}, ${countLine(p.root, [], exclusion)}` : `, ${p.availability}`;
    lines.push(line);
  }
  if (view.truncated) lines.push("  (registry walk truncated)");
  return lines;
}

function sourcesList(home: string, env: EnvLike, io: CliIo): number {
  const config = loadConfig(home, env);
  const exclusion = exclusionFor(home, env);
  const lines: string[] = [];
  for (const s of config.sources) lines.push(...describeSource(s, exclusion));
  lines.push(`sourceGrantRevision: ${sourceGrantRevision(config)}`);
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

function sourcesToggle(enable: boolean, argv: readonly string[], home: string, env: EnvLike, io: CliIo): number {
  const { flags, positional } = parseArgs(argv, ["--project"]);
  if (positional.length !== 1) throw new UsageError();
  const id = positional[0]!;
  const project = flags.get("--project");
  const file = readConfigFile(home);
  const source = file.sources.find((s) => s.id === id);
  if (source === undefined) {
    io.stderr("unknown source id\n");
    return EXIT_FAIL;
  }
  if (project === undefined) {
    source.enabled = enable;
  } else {
    if (source.kind !== "registry_projects") {
      io.stderr("--project applies only to a registry_projects source\n");
      return EXIT_FAIL;
    }
    const resolved = resolveConfig(file, env).sources.find((s) => s.id === id);
    const known = new Set(source.enabledProjects);
    if (resolved?.kind === "registry_projects") {
      for (const p of discoverProjects({ ...resolved, enabledProjects: [] }, { exclusion: exclusionFor(home, env) }).projects) known.add(p.name);
    }
    if (!known.has(project)) {
      io.stderr("unknown project (no registry note names it)\n");
      return EXIT_FAIL;
    }
    const set = new Set(source.enabledProjects);
    if (enable) set.add(project);
    else set.delete(project);
    source.enabledProjects = [...set].sort();
  }
  writeConfig(home, file, env);
  const rev = sourceGrantRevision(loadConfig(home, env));
  io.stdout(`sourceGrantRevision: ${rev}\nrun \`pcm reload\` to apply it to a running service\n`);
  if (project !== undefined && enable && !source.enabled) io.stdout(`note: source ${id} itself is disabled\n`);
  return EXIT_OK;
}

// ---------- process entry ----------

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runCli(process.argv.slice(2), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("pcm: unexpected failure\n");
      process.exitCode = EXIT_FAIL;
    },
  );
}
