// Search over a markdown directory (see markdownDir.ts for the walk and the read gate).
//
// The query is split on whitespace into terms (case-insensitive, at most 8, each at most
// 64 characters). A hit is a window of at most three lines holding every term: it ends on
// the first line by which every term has appeared, counting from a line with any term,
// and starts on the latest line that still keeps every term in the window. Hits are in
// path order, then line order, and never overlap. Each call is capped at 2,000 files,
// 256 KiB read per file, 5 MiB read in all, and SEARCH_DEADLINE_MS of wall-clock time;
// hitting a cap sets `truncated`.

import { deadlineIn, nodeFs, readVerified, SEARCH_DEADLINE_MS, SEARCH_LIMITS, walkFiles, type Deadline, type TreeOptions } from "./markdownDir.js";

export interface SearchHit {
  path: string;
  lines: [number, number];
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

/** Shared per-call search budget, so a registry search over several projects stays within one call's caps. */
export interface ScanBudget {
  files: number;
  bytes: number;
  truncated: boolean;
  deadline: Deadline;
}

/** A fresh per-call budget; the deadline starts now. `now` is injectable for tests. */
export function newScanBudget(now: () => number = Date.now): ScanBudget {
  return { files: 0, bytes: 0, truncated: false, deadline: deadlineIn(SEARCH_DEADLINE_MS, now) };
}

/** Split a query into lower-cased terms, or undefined when it is not a usable query. */
export function parseQuery(query: unknown): string[] | undefined {
  if (typeof query !== "string" || query.length === 0 || query.length > SEARCH_LIMITS.maxQueryChars || query.includes("\0")) {
    return undefined;
  }
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0 || terms.length > SEARCH_LIMITS.maxTerms) return undefined;
  if (terms.some((t) => t.length > SEARCH_LIMITS.maxTermChars)) return undefined;
  return terms;
}

function cutChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

function matchLines(lines: string[], terms: string[], limit: number, path: string, out: SearchHit[]): void {
  const lower = lines.map((l) => l.toLowerCase());
  for (let i = 0; i < lower.length && out.length < limit; i++) {
    const first = lower[i] ?? "";
    if (!terms.some((t) => first.includes(t))) continue;
    const seen = new Set<string>();
    let end = -1;
    for (let j = i; j < Math.min(i + SEARCH_LIMITS.windowLines, lower.length); j++) {
      const l = lower[j] ?? "";
      for (const t of terms) if (l.includes(t)) seen.add(t);
      if (seen.size === terms.length) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    // Tighten the start: the latest line from which the window still holds every term.
    let start = i;
    for (let k = end; k > i; k--) {
      const win = lower.slice(k, end + 1);
      if (terms.every((t) => win.some((l) => l.includes(t)))) {
        start = k;
        break;
      }
    }
    const text = lines
      .slice(start, end + 1)
      .map((l) => l.trim())
      .join(" ")
      .replace(/\s+/g, " ");
    out.push({ path, lines: [start + 1, end + 1], snippet: cutChars(text, SEARCH_LIMITS.maxSnippetChars) });
    i = end;
  }
}

/**
 * Search the tree. `prefix` is prepended to returned paths (registry projects use
 * `<project>/`). `budget` is shared across trees searched in one call, deadline included.
 */
export function searchTree(
  opts: TreeOptions,
  terms: string[],
  limit: number,
  budget: ScanBudget = newScanBudget(),
  prefix = "",
  out: SearchHit[] = [],
): SearchResult {
  const fs = opts.fs ?? nodeFs;
  const walked = walkFiles(opts, Math.max(0, SEARCH_LIMITS.maxFiles - budget.files), budget.deadline);
  if (walked.truncated) budget.truncated = true;
  for (const f of walked.files) {
    if (out.length >= limit) break;
    if (budget.files >= SEARCH_LIMITS.maxFiles || budget.bytes >= SEARCH_LIMITS.maxScanBytes || budget.deadline.now() >= budget.deadline.at) {
      budget.truncated = true;
      break;
    }
    budget.files++;
    const room = Math.min(SEARCH_LIMITS.maxFileBytes, SEARCH_LIMITS.maxScanBytes - budget.bytes);
    const r = readVerified(fs, f.realPath, room);
    if (!r) continue;
    budget.bytes += Buffer.byteLength(r.text, "utf8");
    if (r.cut) budget.truncated = true;
    matchLines(r.text.split(/\r?\n/), terms, limit, prefix + f.rel, out);
  }
  return { hits: out, truncated: budget.truncated };
}
