// The `sources` MCP server the ranking agent gets for one run. Five read-only tools over
// the run's snapshot and enabled sources. Every call goes through the same wrapper:
// count the call against the run budget, do the work, mint evidence ids, charge the
// returned bytes, write the audit line, then commit the ids. A refused or failed call
// commits no ids.
//
// Results carry `structuredContent` and the same object as compact JSON text; the byte
// budget counts the text (see budget.ts). A result over the per-call cap is refused alone
// as `too_large`. Errors are fixed codes only: never a path, query or content.
//
// Arguments: every field's schema ends in `.catch(INVALID)`, so the SDK never rejects a
// call before the handler runs (it has no hook for that). The advertised JSON schema is
// unchanged; a field that fails it arrives as INVALID and the call is counted, audited as
// `invalid-args` (without argument values) and answered with that fixed code.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../clock.js";
import type { ExclusionOptions, FocusHttpSource, RegistryProjectsSource, SourceConfig } from "../config.js";
import { createAuditLog, type AuditLog, type CallAuditRecord, type CallStatus } from "./audit.js";
import { createRunBudget, type RunBudget } from "./budget.js";
import { createEvidenceLedger, type EvidenceLedger, type EvidenceTransaction } from "./evidence.js";
import { fetchFocus, FOCUS_TIMEOUT_MS, type FetchLike, type FocusItem } from "./focus.js";
import { normalizeRelPath, READ_LIMITS, readTreeFile, rootAvailability, SEARCH_LIMITS, type FsOps, type TreeOptions } from "./markdownDir.js";
import { newScanBudget, parseQuery, searchTree, type SearchHit } from "./search.js";
import { discoverProjects, type RegistryView } from "./registryProjects.js";
import { AUDIT_FILE, MAX_SNAPSHOT_OBSERVATIONS, type RunFiles } from "./runFiles.js";

export const SERVER_NAME = "sources";
export const SERVER_VERSION = "0.1.0";
/** The sourceId evidence from the activity snapshot is filed under. */
export const ACTIVITY_SOURCE_ID = "activity";
export const RECALL_NOTE = "recall material, not stated priorities";
const MAX_ACTIVITY_LIMIT = 10;

export interface SourceToolsDeps {
  runDir: string;
  files: RunFiles;
  clock: Clock;
  /** Only get_focus uses it, and only against the configured URL. Defaults to global fetch. */
  fetch?: FetchLike;
  fs?: FsOps;
  exclusion?: ExclusionOptions;
  audit?: AuditLog;
  /** Test seam; defaults to 2 s. */
  focusTimeoutMs?: number;
  /** Test seam: receives the ledger so tests can compare it with the audit file. */
  onLedger?: (ledger: EvidenceLedger) => void;
}

type Payload = Record<string, unknown>;

interface Outcome {
  status: Exclude<CallStatus, "budget_exhausted" | "too-large">;
  code?: string;
  /** Audit only: the underlying reason for a `denied`. */
  detail?: string;
  /** Builds the payload; mints evidence through `tx`. Must be synchronous. */
  build(tx: EvidenceTransaction): Payload;
}

const ok = (build: (tx: EvidenceTransaction) => Payload): Outcome => ({ status: "ok", build });
const fail = (code: string, detail?: string): Outcome => {
  const o: Outcome = { status: "error", code, build: () => ({ status: "error", code }) };
  if (detail !== undefined) o.detail = detail;
  return o;
};

/** What a field that failed its schema turns into (see the header). */
const INVALID: unique symbol = Symbol("invalid-arg");
const orInvalid = <T extends z.ZodType>(schema: T) => schema.catch(() => INVALID as never);
const hasInvalid = (args: object): boolean => Object.values(args).some((v) => v === INVALID);

/** Longer than any real evidence id, so a size estimate made with it is never short. */
const ID_PLACEHOLDER = "e9999999999";

/** Bytes `s` adds inside a JSON string literal (quotes excluded). */
const jsonTextBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s), "utf8") - 2;

/**
 * The longest prefix of `text` whose JSON-escaped form fits `bytes`, cut on a code-point
 * boundary (a lone surrogate counts as one unit, escaped the way JSON.stringify does).
 */
export function cutText(text: string, bytes: number): string {
  if (jsonTextBytes(text) <= bytes) return text;
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const c = jsonTextBytes(ch);
    if (used + c > bytes) break;
    used += c;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * Fit observations (newest first) into `room` bytes of serialized result. Every entry's
 * fields other than `text` are kept whole (the store caps them). When the texts don't all
 * fit, the text room is shared evenly: an entry whose text is under its share keeps it
 * whole and the slack goes to the rest, and each cut text is marked `textTruncated`. An
 * entry is dropped (oldest first) only when the fixed fields alone overflow `room`.
 */
export function packObservations<T extends Payload & { text?: string }>(
  entries: readonly T[],
  room: number,
): { kept: (T & { textTruncated?: true })[]; dropped: boolean; cut: boolean } {
  // Worst-case envelope: `remaining` and every flag present, the id placeholder in place.
  const envelope = Buffer.byteLength(
    JSON.stringify({ status: "ok", observations: [], truncated: false, remaining: MAX_SNAPSHOT_OBSERVATIONS }),
    "utf8",
  );
  const fixed = (e: T): number =>
    Buffer.byteLength(JSON.stringify({ evidenceId: ID_PLACEHOLDER, ...e, text: "", textTruncated: true }), "utf8");
  let list = entries.slice();
  const overheadOf = (xs: readonly T[]): number =>
    envelope + xs.reduce((sum, e) => sum + fixed(e), 0) + Math.max(0, xs.length - 1);
  while (list.length > 0 && overheadOf(list) > room) list.pop();
  const dropped = list.length < entries.length;
  let textRoom = room - overheadOf(list);
  // Water-fill: settle the shortest texts first, then split what is left evenly.
  const need = list.map((e) => (e.text === undefined ? 0 : jsonTextBytes(e.text)));
  const share = new Array<number>(list.length).fill(0);
  const order = list.map((_, i) => i).sort((a, b) => need[a]! - need[b]!);
  let left = order.length;
  for (const i of order) {
    const even = Math.floor(textRoom / left);
    share[i] = Math.min(need[i]!, even);
    textRoom -= share[i]!;
    left--;
  }
  let cut = false;
  const kept = list.map((e, i) => {
    if (e.text === undefined || need[i]! <= share[i]!) return e;
    cut = true;
    return { ...e, text: cutText(e.text, share[i]!), textTruncated: true as const };
  });
  return { kept, dropped, cut };
}

const RO_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export function createSourceToolsServer(deps: SourceToolsDeps): McpServer {
  const { files, clock } = deps;
  const audit = deps.audit ?? createAuditLog(join(deps.runDir, AUDIT_FILE), clock);
  const budget: RunBudget = createRunBudget(files.snapshot.budgets);
  const ledger = createEvidenceLedger();
  deps.onLedger?.(ledger);
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const sources = files.sources.filter((s) => s.enabled);
  const byId = new Map<string, SourceConfig>(sources.map((s) => [s.id, s]));
  const registryCache = new Map<string, RegistryView>();

  const treeFor = (root: string, exclude?: readonly string[]): TreeOptions => {
    const t: TreeOptions = { root };
    if (exclude !== undefined) t.exclude = exclude;
    if (deps.exclusion !== undefined) t.exclusion = deps.exclusion;
    if (deps.fs !== undefined) t.fs = deps.fs;
    return t;
  };

  /** Discovered once per run: the registry is a map fixed for the run's lifetime. */
  const registry = (s: RegistryProjectsSource): RegistryView => {
    let v = registryCache.get(s.id);
    if (!v) {
      const opts: { exclusion?: ExclusionOptions; fs?: FsOps } = {};
      if (deps.exclusion !== undefined) opts.exclusion = deps.exclusion;
      if (deps.fs !== undefined) opts.fs = deps.fs;
      v = discoverProjects(s, opts);
      registryCache.set(s.id, v);
    }
    return v;
  };

  const recallFields = (s: SourceConfig): Payload =>
    s.kind === "markdown_dir" && s.purpose === "task_recall" ? { purpose: "task_recall", note: RECALL_NOTE } : {};

  async function run(tool: string, args: unknown, work: () => Outcome | Promise<Outcome>): Promise<CallToolResult> {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    const respond = (payload: Payload, isError: boolean): CallToolResult => {
      const r: CallToolResult = { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
      if (isError) r.isError = true;
      return r;
    };
    const exhausted = (): CallToolResult => {
      audit.call({ tool, args, status: "budget_exhausted", evidence: [], bytes: 0, ms: ms() });
      return respond({ status: "budget_exhausted" }, true);
    };
    try {
      if (!budget.admitCall()) return exhausted();
      let outcome: Outcome;
      if (args !== null && typeof args === "object" && hasInvalid(args)) {
        args = {}; // no argument values reach the audit, not even hashed
        outcome = { status: "invalid-args", code: "invalid-args", build: () => ({ status: "error", code: "invalid-args" }) };
      } else {
        try {
          outcome = await work();
        } catch {
          outcome = fail("internal");
        }
      }
      // From here to commit is synchronous, so two calls' transactions never interleave.
      let tx = ledger.begin();
      let payload: Payload;
      try {
        payload = outcome.build(tx);
      } catch {
        tx.rollback();
        outcome = fail("internal");
        tx = ledger.begin();
        payload = outcome.build(tx);
      }
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      const admission = budget.admitBytes(bytes);
      if (admission === "exhausted") {
        tx.rollback();
        return exhausted();
      }
      if (admission === "too-large") {
        tx.rollback();
        audit.call({ tool, args, status: "too-large", evidence: [], bytes, ms: ms() });
        return respond({ status: "too_large" }, true);
      }
      try {
        const rec: CallAuditRecord = { tool, args, status: outcome.status, evidence: tx.records, bytes, ms: ms() };
        if (outcome.code !== undefined) rec.code = outcome.code;
        if (outcome.detail !== undefined) rec.detail = outcome.detail;
        audit.call(rec);
      } catch {
        tx.rollback();
        return respond({ status: "error", code: "audit-failed" }, true);
      }
      tx.commit();
      return respond(payload, outcome.status === "error" || outcome.status === "invalid-args");
    } catch {
      return respond({ status: "error", code: "internal" }, true);
    }
  }

  // ---------- tools ----------

  const listSources = (): Outcome =>
    ok(() => ({
      status: "ok",
      sources: sources.map((s) => {
        const entry: Payload = { id: s.id, kind: s.kind };
        if (s.kind === "markdown_dir") {
          if (s.purpose !== undefined) entry.purpose = s.purpose;
          const a = rootAvailability(treeFor(s.root, s.exclude));
          entry.availability = a.ok ? "ok" : `unavailable: ${a.code}`;
          if (s.purpose === "task_recall") entry.note = RECALL_NOTE;
        } else if (s.kind === "registry_projects") {
          const v = registry(s);
          entry.availability = v.availability === "ok" ? "ok" : `unavailable: ${v.availability}`;
          // Disabled projects are counted, never named: their names are not granted.
          entry.projects = v.projects
            .filter((p) => p.enabled)
            .map((p) => ({ name: p.name, availability: p.availability === "ok" ? "ok" : `unavailable: ${p.availability}` }));
          entry.disabledProjectCount = v.projects.filter((p) => !p.enabled).length;
          entry.pathFormat = "<project>/<path inside the project>";
        } else {
          entry.availability = "ok"; // probed only by get_focus
        }
        return entry;
      }),
      activity: { observations: files.snapshot.observations.length },
      note: "Metadata only; not citable evidence. Use the other tools for evidence ids.",
    }));

  const readRecentActivity = (limit: number | undefined, offset: number | undefined): Outcome => {
    const all = files.snapshot.observations;
    const from = Math.min(offset ?? 0, all.length);
    const list = all.slice(from, from + (limit ?? MAX_ACTIVITY_LIMIT));
    return ok((tx) => {
      const entries = list.map((o) => {
        const e: Payload & { text?: string } = { observedAt: o.observedAt, title: o.title, url: o.url, truncated: o.truncated };
        if (o.text !== undefined) e.text = o.text;
        return e;
      });
      // Fit the bytes this call may still use: texts are shortened evenly, so one heavy
      // page can't hide the others.
      const { kept, cut } = packObservations(entries, budget.room);
      const remaining = all.length - from - kept.length;
      return {
        status: "ok",
        observations: kept.map((e, i) => ({
          evidenceId: tx.mint({ kind: "activity", sourceId: ACTIVITY_SOURCE_ID, path: list[i]!.observationId }),
          ...e,
        })),
        truncated: remaining > 0 || cut,
        remaining,
      };
    });
  };

  const hitsPayload = (s: SourceConfig, hits: SearchHit[], truncated: boolean) => (tx: EvidenceTransaction): Payload => ({
    status: "ok",
    sourceId: s.id,
    ...recallFields(s),
    hits: hits.map((h) => ({
      evidenceId: tx.mint({ kind: "note", sourceId: s.id, path: h.path, lines: h.lines }),
      path: h.path,
      lines: h.lines,
      snippet: h.snippet,
    })),
    truncated,
  });

  const searchSource = (sourceId: string, query: string, limit: number | undefined): Outcome => {
    const s = byId.get(sourceId);
    if (!s) return fail("unknown-source");
    const terms = parseQuery(query);
    if (!terms) return fail("invalid-query");
    const max = Math.min(limit ?? SEARCH_LIMITS.maxHits, SEARCH_LIMITS.maxHits);
    const scan = newScanBudget(() => clock.now());
    if (s.kind === "markdown_dir") {
      const r = searchTree(treeFor(s.root, s.exclude), terms, max, scan);
      return ok(hitsPayload(s, r.hits, r.truncated));
    }
    if (s.kind === "registry_projects") {
      const hits: SearchHit[] = [];
      for (const p of registry(s).projects) {
        if (hits.length >= max) break;
        if (!p.enabled || p.availability !== "ok" || p.root === undefined) continue;
        searchTree(treeFor(p.root), terms, max, scan, `${p.name}/`, hits);
      }
      return ok(hitsPayload(s, hits, scan.truncated));
    }
    return fail("unsupported-source");
  };

  const readSource = (sourceId: string, path: string, startLine?: number, endLine?: number): Outcome => {
    const s = byId.get(sourceId);
    if (!s) return fail("unknown-source");
    let tree: TreeOptions;
    let rel: string;
    let prefix = "";
    if (s.kind === "markdown_dir") {
      tree = treeFor(s.root, s.exclude);
      rel = path;
    } else if (s.kind === "registry_projects") {
      const norm = normalizeRelPath(path);
      if (norm === undefined) return fail("invalid-path");
      const slash = norm.indexOf("/");
      if (slash < 0) return fail("denied", "no-project");
      const name = norm.slice(0, slash);
      const p = registry(s).projects.find((x) => x.name === name);
      if (!p || !p.enabled || p.availability !== "ok" || p.root === undefined) return fail("denied", "project-unavailable");
      tree = treeFor(p.root);
      rel = norm.slice(slash + 1);
      prefix = `${name}/`;
    } else {
      return fail("unsupported-source");
    }
    const r = readTreeFile(tree, rel, startLine, endLine);
    if (!r.ok) return fail(r.code, r.detail);
    const shown = prefix + r.path;
    return ok((tx) => {
      const out: Payload = {
        status: "ok",
        sourceId: s.id,
        ...recallFields(s),
        evidenceId: tx.mint({ kind: "note", sourceId: s.id, path: shown, lines: r.lines }),
        path: shown,
        lines: r.lines,
        totalLines: r.totalLines,
      };
      if (r.totalLinesAtLeast) out.totalLinesAtLeast = true;
      out.text = r.text;
      out.truncated = r.truncated;
      if (r.endClamped) out.endClamped = true;
      return out;
    });
  };

  const getFocus = async (): Promise<Outcome> => {
    const s = sources.find((x): x is FocusHttpSource => x.kind === "focus_http");
    if (!s) return { status: "unavailable", code: "not-configured", build: () => ({ status: "unavailable", reason: "not-configured" }) };
    const r = await fetchFocus(s.url, fetchImpl, deps.focusTimeoutMs ?? FOCUS_TIMEOUT_MS);
    if (!r.ok) return { status: "unavailable", code: r.reason, build: () => ({ status: "unavailable", sourceId: s.id, reason: r.reason }) };
    return ok((tx) => ({
      status: "ok",
      sourceId: s.id,
      items: r.items.map((it: FocusItem, i) => {
        const out: Payload = {
          evidenceId: tx.mint({ kind: "focus", sourceId: s.id, path: it.id ?? `#${i + 1}` }),
          title: it.title,
        };
        if (it.tier !== undefined) out.tier = it.tier;
        if (it.now !== undefined) out.now = it.now;
        if (it.note !== undefined) out.note = it.note;
        return out;
      }),
    }));
  };

  // ---------- registration ----------

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const sourceIdArg = orInvalid(z.string().max(64).describe("A source id from list_sources."));

  server.registerTool(
    "list_sources",
    {
      description:
        "List the granted sources: id, kind, purpose and availability (for a project registry, the enabled projects " +
        "and a count of disabled ones). Metadata only; not citable evidence.",
      inputSchema: {},
      annotations: RO_ANNOTATIONS,
    },
    () => run("list_sources", {}, listSources),
  );

  server.registerTool(
    "read_recent_activity",
    {
      description:
        "Pages Hunter viewed recently, newest first, fixed when this run started. Each entry has a citable evidence id. " +
        `Returns entries [offset, offset+limit), at most ${MAX_ACTIVITY_LIMIT} per call. To fit the byte budget, page texts ` +
        "may be shortened (evenly across entries); a shortened entry has `textTruncated: true`. `remaining` counts older " +
        "entries not returned: call again with offset advanced by the entries you got to see them. `truncated` is true " +
        "when entries remain or any text was shortened.",
      inputSchema: {
        limit: orInvalid(z.int().min(1).max(MAX_ACTIVITY_LIMIT).optional()),
        offset: orInvalid(z.int().min(0).max(MAX_SNAPSHOT_OBSERVATIONS).optional()),
      },
      annotations: RO_ANNOTATIONS,
    },
    (args) => run("read_recent_activity", args, () => readRecentActivity(args.limit, args.offset)),
  );

  server.registerTool(
    "search_source",
    {
      description:
        "Case-insensitive search of one note source. All whitespace-separated terms must appear within three lines. " +
        "Returns up to `limit` hits (path, line range, 300-character snippet), each with a citable evidence id.",
      inputSchema: {
        sourceId: sourceIdArg,
        query: orInvalid(z.string().max(SEARCH_LIMITS.maxQueryChars)),
        limit: orInvalid(z.int().min(1).max(SEARCH_LIMITS.maxHits).default(SEARCH_LIMITS.maxHits)),
      },
      annotations: RO_ANNOTATIONS,
    },
    (args) => run("search_source", args, () => searchSource(args.sourceId, args.query, args.limit)),
  );

  server.registerTool(
    "read_source",
    {
      description:
        `Read a line range from one note (a relative path from search_source), at most ${READ_LIMITS.maxLines} lines or 16 KiB. ` +
        "Only a file's first 256 KiB is readable: lines past it are unreachable, and `totalLinesAtLeast` marks such a file. " +
        "`truncated` means the line or byte cap cut the range; `endClamped` means endLine was past the last line. " +
        "A range heavy in control or escape characters can exceed the per-call result cap and return `too_large`; " +
        "ask for a smaller range. " +
        "Returns a citable evidence id for the range.",
      inputSchema: {
        sourceId: sourceIdArg,
        path: orInvalid(z.string().max(1024)),
        startLine: orInvalid(z.int().min(1).max(10_000_000).optional()),
        endLine: orInvalid(z.int().min(1).max(10_000_000).optional()),
      },
      annotations: RO_ANNOTATIONS,
    },
    (args) => run("read_source", args, () => readSource(args.sourceId, args.path, args.startLine, args.endLine)),
  );

  server.registerTool(
    "get_focus",
    {
      description: "Hunter's current Focus board: open items, each with a citable evidence id. Returns unavailable if Focus does not answer.",
      inputSchema: {},
      annotations: RO_ANNOTATIONS,
    },
    () => run("get_focus", {}, getFocus),
  );

  return server;
}

