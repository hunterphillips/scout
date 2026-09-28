// Issue extraction (pure; DOM injected). Ported from the Phase 0 spike.
//
// Reads the identity link's href first and reads text only if it names the
// same issue as the URL, so stale SPA DOM from the previous page is never read
// as the new issue. Only the title and the main issue body are read, through a
// bounded text walker that skips form controls, contenteditable, buttons,
// scripts and hidden subtrees. Never uses textContent/innerText/innerHTML.

import { type IssueRoute, parseIssueRoute } from "../route.js";
import { LIMITS, type Limits, type Selector, SELECTORS } from "../selectors.js";

const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "FORM", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BR", "TR", "BLOCKQUOTE", "TABLE", "SECTION", "DETAILS", "SUMMARY", "HR", "DD", "DT"]);
const EDITABLE_ANCESTOR = 'form, textarea, input, select, [contenteditable]:not([contenteditable="false"])';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8Length = (s: string): number => encoder.encode(s).length;

/** Cut to at most maxBytes of UTF-8 on a code-point boundary. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false, bytes: bytes.length };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true, bytes: end };
}

/** Cut to at most maxChars code points. */
export function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  const cps = Array.from(text);
  if (cps.length <= maxChars) return { text, truncated: false };
  return { text: cps.slice(0, maxChars).join(""), truncated: true };
}

function normalize(s: string): string {
  return s
    .replace(/[ \t\f\v\r ]+/g, " ")
    .replace(/ *\n[ \n]*/g, (m) => (m.split("\n").length > 2 ? "\n\n" : "\n"))
    .trim();
}

/**
 * Bounded text of `el`: text nodes only, skipping controls, editable and
 * hidden subtrees. Stops walking once `maxBytes` (+1 KiB slack for
 * whitespace normalization) of raw text are collected.
 */
export function boundedText(el: Element, maxBytes: number): { text: string; stoppedEarly: boolean } {
  const doc = el.ownerDocument;
  const NF = doc.defaultView?.NodeFilter ?? NodeFilter;
  const pieces: string[] = [];
  let raw = 0;
  let stoppedEarly = false;
  const walker = doc.createTreeWalker(el, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
    acceptNode(n: Node): number {
      if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toUpperCase();
        const ce = e.getAttribute("contenteditable");
        if (SKIP_TAGS.has(tag) || (ce !== null && ce !== "false") || e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true") {
          return NF.FILTER_REJECT;
        }
        if (BLOCK_TAGS.has(tag)) pieces.push("\n");
        return NF.FILTER_SKIP;
      }
      return NF.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue ?? "";
    pieces.push(v);
    raw += utf8Length(v);
    if (raw > maxBytes + 1024) {
      stoppedEarly = true;
      break;
    }
  }
  return { text: normalize(pieces.join("")), stoppedEarly };
}

type Match = { el: Element; id: string; ambiguous?: never } | { ambiguous: true; id: string; el?: never };

function unique(doc: Document, candidates: readonly Selector[]): Match | null {
  for (const c of candidates) {
    const els = doc.querySelectorAll(c.css);
    const first = els[0];
    if (els.length === 1 && first) return { el: first, id: c.id };
    if (els.length > 1) return { ambiguous: true, id: c.id };
  }
  return null;
}

function isEditable(el: Element): boolean {
  return !!el.closest(EDITABLE_ANCESTOR) || (el as HTMLElement).isContentEditable === true;
}

export type ExtractResult =
  | { ok: true; title: string; body: string; titleTruncated: boolean; bodyTruncated: boolean }
  | { ok: false; reason: string };

/** Extract title + main body for `route` from `doc`. */
export function extractIssue(doc: Document, route: IssueRoute, limits: Limits = LIMITS): ExtractResult {
  const idm = unique(doc, SELECTORS.identity);
  if (!idm) return { ok: false, reason: "identity-missing" };
  if (idm.ambiguous) return { ok: false, reason: "identity-ambiguous" };
  const href = idm.el.getAttribute("href");
  let idRoute: IssueRoute | null = null;
  try {
    const u = new URL(href ?? "", "https://github.com");
    u.hash = "";
    u.search = "";
    idRoute = parseIssueRoute(u.href);
  } catch {
    idRoute = null;
  }
  if (!idRoute || idRoute.key !== route.key) return { ok: false, reason: "identity-mismatch" };

  const t = unique(doc, SELECTORS.title);
  const b = unique(doc, SELECTORS.body);
  if (!t || !b) return { ok: false, reason: !t ? "title-missing" : "body-missing" };
  if (t.ambiguous || b.ambiguous) return { ok: false, reason: "ambiguous" };
  if (isEditable(t.el) || isEditable(b.el)) return { ok: false, reason: "editable" };

  const tt = boundedText(t.el, limits.titleChars * 4);
  const title = truncateChars(tt.text.replace(/\s+/g, " "), limits.titleChars);
  if (!title.text) return { ok: false, reason: "title-empty" };
  const bt = boundedText(b.el, limits.bodyBytes);
  const body = truncateUtf8(bt.text, limits.bodyBytes);
  return {
    ok: true,
    title: title.text,
    body: body.text,
    titleTruncated: title.truncated || tt.stoppedEarly,
    bodyTruncated: body.truncated || bt.stoppedEarly,
  };
}
