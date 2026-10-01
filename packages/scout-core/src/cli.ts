import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@scout/contracts";
import { createSiteResourceDiscoverer, type DiscoveryResult } from "./capabilities/discovery.js";
import type { CatalogCacheResult } from "./catalog/cache.js";
import type { Sleep } from "./catalog/pacing.js";
import { type CatalogResolveStats, createCatalogResolver } from "./catalog/resolveCatalog.js";
import { slugTitle } from "./catalog/resolver.js";
import { type VerifyFetch, type VerifyResult, verifyTargets } from "./catalog/verifyTargets.js";
import { type Clock, systemClock } from "./clock.js";
import { createDiagnostics, defaultDiagnosticsPath, type Diagnostics, scoutHome } from "./diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "./fetch/guardedFetch.js";

/**
 * Scout's developer CLI: `node packages/scout-core/dist/cli.js <command>`.
 *
 * - `catalog <origin> [--refresh] [--json]` resolves one site's catalog through the
 *   on-disk cache (`~/.scout/cache/catalog`, honoring `SCOUT_HOME`) and prints a summary.
 * - `verify <url>...` runs `verifyTargets` on up to `VERIFY_CLI_MAX_URLS` (10) URLs, all
 *   fetched in parallel; more is a usage error rather than a larger fan-out. The origin is
 *   the first URL's; a URL on any other origin is a usage error.
 * - `discover <origin> [--refresh] [--json]` runs website resource discovery (`llms.txt`,
 *   `AGENTS.md`, the skills index and its skills) through the on-disk discovery cache and
 *   prints one line per probe. Resource text is never printed; `--json` omits it too.
 * - `rank <origin>` is not available until Phase 3.
 *
 * Only `catalog`, `discover`, and `verify` touch the network, and only when invoked. Importing this
 * module does nothing; the process entry runs `runCli` only when this file is `argv[1]`.
 */

/** Most URLs one `verify` run accepts; they are all fetched in parallel. */
export const VERIFY_CLI_MAX_URLS = 10;

export const USAGE = `usage:
  cli.js catalog <https-origin> [--refresh] [--json]
  cli.js discover <https-origin> [--refresh] [--json]
  cli.js verify <url>...            (at most ${VERIFY_CLI_MAX_URLS} URLs, all on one origin)
  cli.js rank <https-origin>        (Phase 3)
`;

/** How many candidates `catalog` lists after the summary. */
export const CATALOG_PREVIEW = 20;

export interface CliDeps {
  /** Defaults to the real `guardedFetch`; the catalog resolver's paced fetch calls it. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Defaults to the real `guardedFetch` with only the named verify options. */
  verifyFetch?: VerifyFetch;
  clock?: Clock;
  sleep?: Sleep;
  /** Defaults to the JSONL sink at `defaultDiagnosticsPath(env)`. */
  diagnostics?: Diagnostics;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  deps?: CliDeps;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_UNAVAILABLE = 2;

export type ParsedOrigin = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Any string that parses to a bare `https:` origin: no path other than `/`, no query,
 * fragment or credentials. Returns the normalized `url.origin`, so `https://S.example`,
 * an IDN host and `https://h:443` are all accepted.
 */
export function parseOrigin(raw: string): ParsedOrigin {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "origin must be https" };
  if (url.username || url.password) return { ok: false, reason: "origin must not carry credentials" };
  if (url.pathname !== "/") return { ok: false, reason: "origin must not have a path" };
  if (url.search || url.hash) return { ok: false, reason: "origin must not have a query or fragment" };
  return { ok: true, origin: url.origin };
}

/** An ISO timestamp, or "invalid" when `ms` is not a representable date. */
export function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "invalid";
  }
}

/** A one-line error naming only the error's class; its message may carry URLs. */
function errorLine(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  return `error: ${name}\n`;
}

/**
 * Run one CLI command and return its exit code. Output goes only through `io`.
 * `--help`/`-h` prints usage to stdout and exits 0; misuse prints usage to stderr and
 * exits 1. An unexpected throw is caught: one `error: <name>` line on stderr, exit 1.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const usage = (reason?: string): number => {
    if (reason) io.stderr(`${reason}\n`);
    io.stderr(USAGE);
    return EXIT_FAIL;
  };
  const [command, ...rest] = argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (command === undefined) return usage();
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  try {
    switch (command) {
      case "catalog": {
        if (positional.length !== 1 || flags.some((f) => f !== "--refresh" && f !== "--json")) return usage();
        const parsed = parseOrigin(positional[0] as string);
        if (!parsed.ok) return usage(`catalog: ${parsed.reason}`);
        return await catalogCommand(parsed.origin, { refresh: flags.includes("--refresh"), json: flags.includes("--json") }, io);
      }
      case "discover": {
        if (positional.length !== 1 || flags.some((f) => f !== "--refresh" && f !== "--json")) return usage();
        const parsed = parseOrigin(positional[0] as string);
        if (!parsed.ok) return usage(`discover: ${parsed.reason}`);
        return await discoverCommand(parsed.origin, { refresh: flags.includes("--refresh"), json: flags.includes("--json") }, io);
      }
      case "verify": {
        if (positional.length === 0 || flags.length > 0) return usage();
        if (positional.length > VERIFY_CLI_MAX_URLS) return usage(`verify: at most ${VERIFY_CLI_MAX_URLS} URLs`);
        const origin = verifyOrigin(positional);
        if (!origin.ok) return usage(`verify: ${origin.reason}`);
        return await verifyCommand(origin.origin, positional, io);
      }
      case "rank":
        io.stderr("rank: not available until Phase 3\n");
        return EXIT_UNAVAILABLE;
      default:
        return usage();
    }
  } catch (error) {
    io.stderr(errorLine(error));
    return EXIT_FAIL;
  }
}

async function catalogCommand(origin: string, opts: { refresh: boolean; json: boolean }, io: CliIo): Promise<number> {
  const deps = io.deps ?? {};
  const env = io.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const diagnostics = deps.diagnostics ?? createDiagnostics({ path: defaultDiagnosticsPath(env), clock });
  const resolver = createCatalogResolver({
    scoutHome: scoutHome(env),
    clock,
    diagnostics,
    ...(deps.guardedFetch ? { guardedFetch: deps.guardedFetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const { result, stats } = await resolver.resolve(origin, { refresh: opts.refresh });

  if (!result.ok) {
    io.stderr(`catalog failed: ${result.code}${result.errors.length ? ` (${result.errors.join(", ")})` : ""}\n`);
    io.stderr(`requests ${stats.requests}, refused ${stats.refused}, ${stats.bytesReceived} decoded bytes received, ${stats.ms} ms\n`);
    return EXIT_FAIL;
  }
  if (opts.json) io.stdout(`${JSON.stringify(result.catalog, null, 2)}\n`);
  else io.stdout(formatCatalog(result, stats));
  return result.catalog.candidates.length === 0 && result.catalog.errors.length > 0 ? EXIT_FAIL : EXIT_OK;
}

/** The human-readable `catalog` summary followed by the first `CATALOG_PREVIEW` candidates. */
export function formatCatalog(
  result: Extract<CatalogCacheResult, { ok: true }>,
  stats: CatalogResolveStats,
): string {
  const { catalog } = result;
  const byQuality: Record<Candidate["labelQuality"], number> = { published: 0, image_title: 0, slug: 0 };
  let labelBytes = 0;
  const encoder = new TextEncoder();
  for (const c of catalog.candidates) {
    byQuality[c.labelQuality] += 1;
    labelBytes += encoder.encode(c.title).length + (c.description ? encoder.encode(c.description).length : 0);
  }
  const lines = [
    `origin       ${catalog.origin}`,
    `source       ${result.source}${result.stale ? " (stale)" : ""}`,
    `fetched at   ${formatTimestamp(catalog.fetchedAt)}`,
    `candidates   ${catalog.candidates.length} (published ${byQuality.published}, image_title ${byQuality.image_title}, slug ${byQuality.slug})`,
    `truncated    ${catalog.truncated ? "yes" : "no"}`,
    `errors       ${catalog.errors.length ? catalog.errors.join(", ") : "none"}`,
    `label bytes  ${labelBytes}`,
    `requests     ${stats.requests}, refused ${stats.refused}, ${stats.bytesReceived} decoded bytes received`,
    `time         ${stats.ms} ms`,
  ];
  const preview = catalog.candidates.slice(0, CATALOG_PREVIEW);
  if (preview.length > 0) {
    lines.push("", `first ${preview.length}:`);
    for (const c of preview) lines.push(`${c.id}  ${c.labelQuality}  ${c.title}  —  ${c.sourceUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

async function discoverCommand(origin: string, opts: { refresh: boolean; json: boolean }, io: CliIo): Promise<number> {
  const deps = io.deps ?? {};
  const env = io.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const diagnostics = deps.diagnostics ?? createDiagnostics({ path: defaultDiagnosticsPath(env), clock });
  const discoverer = createSiteResourceDiscoverer({
    scoutHome: scoutHome(env),
    clock,
    diagnostics,
    ...(deps.guardedFetch ? { guardedFetch: deps.guardedFetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const result = await discoverer.discover(origin, { refresh: opts.refresh });
  io.stdout(opts.json ? `${JSON.stringify(withoutText(result), null, 2)}\n` : formatDiscovery(result));
  return EXIT_OK;
}

/** The result with each resource's text replaced by its length, for printing. */
function withoutText(result: DiscoveryResult): unknown {
  return {
    ...result,
    items: result.items.map((item) => (item.resource ? { ...item, resource: { ...item.resource, text: undefined } } : item)),
  };
}

/** One line per probe: kind, status (and code), where the answer came from, bytes, and the URL. */
export function formatDiscovery(result: DiscoveryResult): string {
  const lines = [`origin       ${result.origin}`, `robots       ${result.robots}`];
  for (const item of result.items) {
    const label = item.kind === "skill" ? `skill ${item.entry?.name ?? `#${item.entry?.position ?? "?"}`}` : item.kind;
    const status = item.code ? `${item.status} (${item.code})` : item.status;
    const bytes = item.resource ? `  ${item.resource.byteLength} B sha256:${item.resource.sha256.slice(0, 12)}` : "";
    lines.push(`${label.padEnd(24)} ${status.padEnd(28)} ${item.source}${bytes}  ${item.sourceUrl ?? "-"}`);
  }
  for (const ref of result.externalReferences) lines.push(`${`skill ${ref.name}`.padEnd(24)} ${"external reference".padEnd(28)} not fetched  ${ref.url}`);
  if (result.skillsOverCap > 0) lines.push(`skills over the index cap: ${result.skillsOverCap} (not examined)`);
  lines.push(
    `accepted     ${result.acceptedBytes} bytes`,
    `requests     ${result.stats.requests}, refused ${result.stats.refused}`,
    `time         ${result.stats.ms} ms`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The origin every `verify` URL must share: the first URL's. A first URL that does not
 * parse, or any later URL that parses to another origin, is refused; a later URL that
 * does not parse is left for `verifyTargets` to drop as `invalid_url`.
 */
export function verifyOrigin(urls: readonly string[]): ParsedOrigin {
  const originOf = (url: string): string | null => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const origin = originOf(urls[0] ?? "");
  if (origin === null || origin === "null") return { ok: false, reason: "the first URL is not a URL with an origin" };
  for (const url of urls.slice(1)) {
    const other = originOf(url);
    if (other !== null && other !== origin) return { ok: false, reason: "all URLs must share one origin" };
  }
  return { ok: true, origin };
}

async function verifyCommand(origin: string, urls: readonly string[], io: CliIo): Promise<number> {
  const deps = io.deps ?? {};
  const candidates: Candidate[] = urls.map((url, i) => ({
    id: `c${i.toString(36)}`,
    sourceUrl: url,
    title: safeSlugTitle(url),
    labelQuality: "slug",
    provenance: "sitemap",
  }));
  const result = await verifyTargets(candidates, {
    origin,
    maxCandidates: candidates.length,
    ...(deps.verifyFetch ? { fetch: deps.verifyFetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  io.stdout(formatVerify(candidates, result));
  return EXIT_OK;
}

/** One line per input URL: its `humanHref` (and display title) or why it was dropped. */
export function formatVerify(candidates: readonly Candidate[], result: VerifyResult): string {
  const lines = candidates.map((c) => {
    const kept = result.verified.find((v) => v.id === c.id);
    if (kept) return `${c.sourceUrl}  ->  ${kept.humanHref}${kept.displayTitle ? `  "${kept.displayTitle}"` : ""}`;
    const drop = result.dropped.find((d) => d.candidateId === c.id);
    return `${c.sourceUrl}  ->  dropped: ${drop?.reason ?? "unknown"}`;
  });
  lines.push(`(${result.ms} ms)`);
  return `${lines.join("\n")}\n`;
}

function safeSlugTitle(url: string): string {
  try {
    return slugTitle(url);
  } catch {
    return "";
  }
}

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
    (error: unknown) => {
      process.stderr.write(errorLine(error));
      process.exitCode = EXIT_FAIL;
    },
  );
}
