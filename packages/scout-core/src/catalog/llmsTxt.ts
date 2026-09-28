import { type CatalogFetch, TEXT_SOURCE_MAX_BYTES } from "./catalogFetch.js";
import { sameOriginHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";

/** Most nested `llms.txt` files followed beyond the root file. */
export const MAX_NESTED_LLMS_TXT = 5;

export interface LlmsTxtEntry {
  url: string;
  title: string;
  description?: string;
  provenance: "llms.txt";
}

export interface ParsedLlmsTxt {
  entries: LlmsTxtEntry[];
  /** Same-origin links to other `llms.txt` files, deduplicated, in document order. */
  nestedLlmsTxtUrls: string[];
  /** Links dropped because they were not same-origin `https:` URLs. */
  droppedOffOrigin: number;
}

export type FetchedLlmsTxt =
  | { found: false; source: "absent" | "error" }
  | {
      found: true;
      entries: LlmsTxtEntry[];
      /** Files read, including the root. */
      filesFetched: number;
      /** Nested files that were absent or failed to fetch. */
      nestedFailed: number;
      /** Nested links beyond `MAX_NESTED_LLMS_TXT`, plus any found in nested files (depth 1). */
      nestedSkipped: number;
      droppedOffOrigin: number;
    };

// `- [label](url)` or `* [label](url)`, an optional quoted link title, then an optional `: description`.
const LINK_LINE = /^\s*[-*+]\s+\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)(?:\s*:\s*(.*))?$/;

function isNestedLlmsTxt(url: URL): boolean {
  return /(?:^|\/)llms\.txt$/.test(url.pathname);
}

/**
 * Parse an `llms.txt` file.
 *
 * Policy: only Markdown link list items are read. Links resolve against `baseUrl` (the
 * file's own URL) and are kept only if they are same-origin `https:` URLs; everything else
 * is dropped and counted. Labels and descriptions pass through `sanitizeLabel` and are
 * data only. A same-origin link to another `llms.txt` is reported in `nestedLlmsTxtUrls`
 * instead of becoming an entry.
 */
export function parseLlmsTxt(text: string, origin: string, baseUrl: string = `${origin}/llms.txt`): ParsedLlmsTxt {
  const entries: LlmsTxtEntry[] = [];
  const nested = new Set<string>();
  let droppedOffOrigin = 0;
  let self: string | null = null;
  try {
    self = new URL(baseUrl).toString();
  } catch {
    // An unusable base leaves `self` null; every link then fails the origin check anyway.
  }

  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = LINK_LINE.exec(line);
    if (!match) continue;
    const [, label = "", href = "", description] = match;
    const url = sameOriginHttpsUrl(href, origin, baseUrl);
    if (!url) {
      droppedOffOrigin += 1;
      continue;
    }
    if (isNestedLlmsTxt(url)) {
      if (url.toString() !== self) nested.add(url.toString());
      continue;
    }
    const entry: LlmsTxtEntry = { url: url.toString(), title: sanitizeLabel(label, CANDIDATE_TITLE_MAX), provenance: "llms.txt" };
    const cleanDescription = description === undefined ? "" : sanitizeLabel(description, CANDIDATE_DESCRIPTION_MAX);
    if (cleanDescription) entry.description = cleanDescription;
    entries.push(entry);
  }
  return { entries, nestedLlmsTxtUrls: [...nested], droppedOffOrigin };
}

/**
 * Fetch `${origin}/llms.txt` and, one level deep, up to `MAX_NESTED_LLMS_TXT` nested
 * `llms.txt` files it links to. Nested files contribute entries; their own nested links
 * are not followed. Each file is capped at 512 KiB.
 */
export async function fetchLlmsTxt(origin: string, fetch: CatalogFetch): Promise<FetchedLlmsTxt> {
  const rootUrl = `${origin}/llms.txt`;
  const root = await fetch(rootUrl, { maxBytes: TEXT_SOURCE_MAX_BYTES, accept: "text/markdown, text/plain" });
  if (root.kind === "absent") return { found: false, source: "absent" };
  if (root.kind !== "ok") return { found: false, source: "error" };

  const parsed = parseLlmsTxt(root.body, origin, rootUrl);
  const entries = [...parsed.entries];
  let droppedOffOrigin = parsed.droppedOffOrigin;
  let filesFetched = 1;
  let nestedFailed = 0;
  let nestedSkipped = Math.max(0, parsed.nestedLlmsTxtUrls.length - MAX_NESTED_LLMS_TXT);

  for (const nestedUrl of parsed.nestedLlmsTxtUrls.slice(0, MAX_NESTED_LLMS_TXT)) {
    const result = await fetch(nestedUrl, { maxBytes: TEXT_SOURCE_MAX_BYTES, accept: "text/markdown, text/plain" });
    if (result.kind !== "ok") {
      nestedFailed += 1;
      continue;
    }
    filesFetched += 1;
    const child = parseLlmsTxt(result.body, origin, nestedUrl);
    entries.push(...child.entries);
    droppedOffOrigin += child.droppedOffOrigin;
    nestedSkipped += child.nestedLlmsTxtUrls.length;
  }
  return { found: true, entries, filesFetched, nestedFailed, nestedSkipped, droppedOffOrigin };
}
