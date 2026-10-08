// Page extraction (pure; DOM injected).
//
// Reads the page's main content: the first of `main`, `[role="main"]`,
// `article`, else `body`, through a bounded text walker that skips form
// controls, contenteditable, buttons, scripts, hidden subtrees and page chrome
// (nav, header, footer, aside, dialog and their landmark roles). The title is
// document.title, else the first h1. Nothing is read while the focused element
// is editable, so a page being typed into is not read mid-edit. Never uses
// textContent/innerText/innerHTML.

import { LIMITS, type Limits } from "../limits.js";

const SKIP_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "DIALOG", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "FORM", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BR", "TR", "BLOCKQUOTE", "TABLE", "SECTION", "DETAILS", "SUMMARY", "HR", "DD", "DT"]);
const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary"]);
/** Elements that take typing (a focused checkbox or button is not "typing"). */
const EDITABLE =
  'textarea, select, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="file"], [type="range"], [type="color"], [type="hidden"]), [contenteditable]:not([contenteditable="false"])';
const ROOTS = ["main", '[role="main"]', "article"];
/** A body shorter than this after normalization is not worth sending. */
const MIN_BODY_BYTES = 40;

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
        if (
          SKIP_TAGS.has(tag) ||
          (ce !== null && ce !== "false") ||
          e.hasAttribute("hidden") ||
          e.getAttribute("aria-hidden") === "true" ||
          SKIP_ROLES.has(e.getAttribute("role") ?? "")
        ) {
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

function isEditable(el: Element): boolean {
  return !!el.closest(EDITABLE) || (el as HTMLElement).isContentEditable === true;
}

const isHidden = (el: Element): boolean => !!el.closest('[hidden], [aria-hidden="true"]');

/** The page's main content: the first visible `main`, `[role="main"]`, `article`, else `body`. */
function contentRoot(doc: Document): Element | null {
  for (const css of ROOTS) {
    for (const el of doc.querySelectorAll(css)) if (!isHidden(el)) return el;
  }
  return doc.body;
}

export type ExtractResult =
  | { ok: true; title: string; body: string; titleTruncated: boolean; bodyTruncated: boolean }
  | { ok: false; reason: "no-content" | "editing" };

/** Extract the title and main content of `doc`. */
export function extractPage(doc: Document, limits: Limits = LIMITS): ExtractResult {
  const active = doc.activeElement;
  if (active && active !== doc.body && isEditable(active)) return { ok: false, reason: "editing" };
  const root = contentRoot(doc);
  if (!root) return { ok: false, reason: "no-content" };
  const bt = boundedText(root, limits.bodyBytes);
  const body = truncateUtf8(bt.text, limits.bodyBytes);
  if (body.bytes < MIN_BODY_BYTES) return { ok: false, reason: "no-content" };

  let rawTitle = (doc.title ?? "").replace(/\s+/g, " ").trim();
  let titleCut = false;
  if (!rawTitle) {
    const h1 = doc.querySelector("h1");
    if (h1) {
      const tt = boundedText(h1, limits.titleChars * 4);
      rawTitle = tt.text.replace(/\s+/g, " ");
      titleCut = tt.stoppedEarly;
    }
  }
  const title = truncateChars(rawTitle, limits.titleChars);
  return {
    ok: true,
    title: title.text,
    body: body.text,
    titleTruncated: title.truncated || titleCut,
    bodyTruncated: body.truncated || bt.stoppedEarly,
  };
}
