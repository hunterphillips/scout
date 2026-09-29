import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@scout/contracts";
import { type CatalogCacheResult, createCatalogCache } from "./catalog/cache.js";
import { createPacedCatalogFetch, type Sleep } from "./catalog/pacing.js";
import { slugTitle } from "./catalog/resolver.js";
import { type VerifyFetch, type VerifyResult, verifyTargets } from "./catalog/verifyTargets.js";
import { type Clock, systemClock } from "./clock.js";
import { createDiagnostics, defaultDiagnosticsPath, type Diagnostics, scoutHome } from "./diagnostics.js";
import { type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "./fetch/guardedFetch.js";

/**
 * Scout's developer CLI: `node packages/scout-core/dist/cli.js <command>`.
 *
 * - `catalog <origin> [--refresh] [--json]` resolves one site's catalog through the
 *   on-disk cache (`~/.scout/cache/catalog`, honoring `SCOUT_HOME`) and prints a summary.
 * - `verify <url>...` runs `verifyTargets` on up to `VERIFY_CLI_MAX_URLS` (10) URLs, all
 *   fetched in parallel; more is a usage error rather than a larger fan-out.
 * - `rank <origin>` is not available until Phase 3.
 *
 * Only `catalog` and `verify` touch the network, and only when invoked. Importing this
 * module does nothing; the process entry runs `runCli` only when this file is `argv[1]`.
 */

/** Most URLs one `verify` run accepts; they are all fetched in parallel. */
export const VERIFY_CLI_MAX_URLS = 10;

export const USAGE = `usage:
  cli.js catalog <https-origin> [--refresh] [--json]
  cli.js verify <url>...            (at most ${VERIFY_CLI_MAX_URLS} URLs)
  cli.js rank <https-origin>        (Phase 3)
`;

/** How many candidates `catalog` lists after the summary. */
export const CATALOG_PREVIEW = 20;

export interface CliDeps {
  /** Defaults to the real `guardedFetch`; the catalog's paced fetch calls it. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Defaults to the real `guardedFetch` with only the named verify options. */
  verifyFetch?: VerifyFetch;
  clock?: Clock;
  sleep?: Sleep;
  /** Defaults to `<scout home>/cache/catalog`. */
  cacheDir?: string;
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
      case "verify":
        if (positional.length === 0 || flags.length > 0) return usage();
        if (positional.length > VERIFY_CLI_MAX_URLS) return usage(`verify: at most ${VERIFY_CLI_MAX_URLS} URLs`);
        return await verifyCommand(positional, io);
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
  const baseFetch = deps.guardedFetch ?? guardedFetch;
  let requests = 0;
  let bytesReceived = 0;
  // Counts every request that reached guardedFetch and the decoded bytes of each `ok` body.
  const countingFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    requests += 1;
    const result = await baseFetch(url, options);
    if (result.kind === "ok") bytesReceived += result.bytes.byteLength;
    return result;
  };
  const fetch = createPacedCatalogFetch({ origin, clock, guardedFetch: countingFetch, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const diagnostics = deps.diagnostics ?? createDiagnostics({ path: defaultDiagnosticsPath(env), clock });
  const cache = createCatalogCache({ clock, diagnostics, dir: deps.cacheDir ?? join(scoutHome(env), "cache", "catalog") });

  const started = clock.now();
  const result = await cache.resolve({ origin, fetch, refresh: opts.refresh });
  const ms = clock.now() - started;

  if (!result.ok) {
    io.stderr(`catalog failed: ${result.code}${result.errors.length ? ` (${result.errors.join(", ")})` : ""}\n`);
    io.stderr(`requests ${requests}, refused ${fetch.refused}, ${bytesReceived} decoded bytes received, ${ms} ms\n`);
    return EXIT_FAIL;
  }
  if (opts.json) io.stdout(`${JSON.stringify(result.catalog, null, 2)}\n`);
  else io.stdout(formatCatalog(result, { requests, bytesReceived, refused: fetch.refused, ms }));
  return result.catalog.candidates.length === 0 && result.catalog.errors.length > 0 ? EXIT_FAIL : EXIT_OK;
}

/** The human-readable `catalog` summary followed by the first `CATALOG_PREVIEW` candidates. */
export function formatCatalog(
  result: Extract<CatalogCacheResult, { ok: true }>,
  stats: { requests: number; bytesReceived: number; refused: number; ms: number },
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

async function verifyCommand(urls: readonly string[], io: CliIo): Promise<number> {
  const deps = io.deps ?? {};
  const candidates: Candidate[] = urls.map((url, i) => ({
    id: `c${i.toString(36)}`,
    sourceUrl: url,
    title: safeSlugTitle(url),
    labelQuality: "slug",
    provenance: "sitemap",
  }));
  const result = await verifyTargets(candidates, {
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
