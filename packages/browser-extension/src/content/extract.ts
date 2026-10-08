// Page extraction (pure; DOM injected).
//
// Reads the page's main content: the first of `main`, `[role="main"]`,
// `article`, else `body`, through a bounded text walker that skips form
// controls, contenteditable, buttons, scripts, page chrome (nav, aside,
// dialog, the banner/contentinfo/navigation/complementary roles, and a header
// or footer that is not inside article, aside, main, nav or section, which is
// the page's banner or contentinfo) and anything hidden from the reader: the
// hidden attribute, aria-hidden, display:none, content-visibility:hidden,
// opacity:0 and visibility:hidden. Sections the site collapsed for the
// reader to expand are read: the body of a closed <details> and
// hidden="until-found" content, minus anything hidden inside them. The 8 KiB
// body cap applies to the whitespace-normalized text that is sent. The title is
// document.title, else the first h1. Nothing is read while the focused element
// is editable, so a page being typed into is not read mid-edit. Never uses
// textContent/innerText/innerHTML.

import { LIMITS, type Limits } from "../limits.js";

const SKIP_TAGS = new Set(["NAV", "ASIDE", "DIALOG", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "FORM", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BR", "TR", "BLOCKQUOTE", "TABLE", "SECTION", "DETAILS", "SUMMARY", "HR", "DD", "DT", "HEADER", "FOOTER"]);
const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary"]);
/** A header or footer inside one of these is content, not the page's banner or contentinfo (HTML-AAM). */
const SECTIONING = 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]';
/** Ancestors whose contents the site collapsed for the reader to expand. */
const COLLAPSED = 'details:not([open]), [hidden="until-found" i]';
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

/** Whitespace the normalizer collapses (NBSP included). */
const WS_RUN = /[ \t\f\v\r\u00a0\n]+/g;
const HAS_TEXT = /[^ \t\f\v\r\u00a0\n]/;

/**
 * Whitespace-normalizing writer with a byte budget. A whitespace run between
 * two pieces of text becomes "\n\n" if it holds two or more newlines, "\n" if
 * one, else " "; leading and trailing whitespace (any Unicode space) is
 * dropped. Output stops at `maxBytes` of UTF-8, cut on a code-point boundary;
 * `truncated` is set, and the walk stops, once non-whitespace text does not fit.
 */
class BoundedWriter {
  private readonly out: string[] = [];
  private bytes = 0;
  private newlines = 0;
  private space = false;
  private full = false;
  truncated = false;
  constructor(private readonly maxBytes: number) {}

  /** Append raw text; false once the budget is spent. */
  write(raw: string): boolean {
    let last = 0;
    for (const m of raw.matchAll(WS_RUN)) {
      if (m.index > last && !this.emit(raw.slice(last, m.index))) return false;
      for (const c of m[0]) if (c === "\n") this.newlines++;
      this.space = true;
      last = m.index + m[0].length;
    }
    return last < raw.length ? this.emit(raw.slice(last)) : true;
  }

  private emit(word: string): boolean {
    if (this.bytes === 0) word = word.trimStart();
    if (!word) return true;
    // Once full, only text that is not some other Unicode space counts as cut off.
    if (this.full) return !(this.truncated = /\S/.test(word));
    const sep = this.bytes === 0 ? "" : this.newlines >= 2 ? "\n\n" : this.newlines === 1 ? "\n" : this.space ? " " : "";
    this.newlines = 0;
    this.space = false;
    const cut = truncateUtf8(word, Math.max(0, this.maxBytes - this.bytes - sep.length));
    if (cut.bytes > 0) {
      this.out.push(sep, cut.text);
      this.bytes += sep.length + cut.bytes;
    }
    if (!cut.truncated) return true;
    this.full = true;
    return !(this.truncated = /\S/.test(word.slice(cut.text.length)));
  }

  get text(): string {
    return this.out.join("").trimEnd();
  }
}

const isUntilFound = (e: Element): boolean => e.getAttribute("hidden")?.toLowerCase() === "until-found";

/** The hidden attribute, other than hidden="until-found" (a collapsed section). */
const hiddenAttr = (e: Element): boolean => e.hasAttribute("hidden") && !isUntilFound(e);

/** `e`'s own style hides its subtree: display:none, opacity:0, or content-visibility:hidden other than until-found's. */
function ownStyleHides(e: Element, view: Window): boolean {
  const cs = view.getComputedStyle(e);
  return cs.display === "none" || cs.opacity === "0" || (cs.getPropertyValue("content-visibility") === "hidden" && !isUntilFound(e));
}

/**
 * Whether `e` hides its whole subtree: display:none (or no box at all),
 * content-visibility:hidden, opacity:0. Uses Element.checkVisibility where it
 * exists, falling back to computed style. content-visibility:auto content
 * that is merely off screen still counts. `visibility` is not checked here:
 * a descendant can override it, so it is checked per text node.
 *
 * Collapsed sections are the exception: Chrome reports everything inside a
 * closed <details> or hidden="until-found" as not visible (both skip their
 * contents with content-visibility:hidden), so below one of those only `e`'s
 * own style decides. Callers check ancestors top-down, so anything else above
 * `e` that hides it has already been rejected.
 */
function hidesSubtree(e: Element, view: Window): boolean {
  if (typeof e.checkVisibility === "function") {
    if (e.checkVisibility({ opacityProperty: true })) {
      // checkVisibility looks at ancestors' content-visibility, not the element's own.
      return view.getComputedStyle(e).getPropertyValue("content-visibility") === "hidden" && !isUntilFound(e);
    }
    if (e.parentElement?.closest(COLLAPSED)) return ownStyleHides(e, view);
    // No box of its own: display:contents children still render.
    return view.getComputedStyle(e).display !== "contents";
  }
  return ownStyleHides(e, view);
}

/** A header or footer outside article, aside, main, nav and section: the page's banner or contentinfo. */
const isPageChrome = (e: Element, tag: string): boolean => (tag === "HEADER" || tag === "FOOTER") && !e.parentElement?.closest(SECTIONING);

/**
 * Bounded text of `el`: text nodes only, skipping controls, editable, page
 * chrome, hidden-attribute and CSS-hidden subtrees and visibility:hidden text.
 * Whitespace is collapsed while walking, and the walk stops once `maxBytes`
 * of normalized text are written.
 */
export function boundedText(el: Element, maxBytes: number): { text: string; truncated: boolean } {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const NF = view?.NodeFilter ?? NodeFilter;
  const out = new BoundedWriter(maxBytes);
  const walker = doc.createTreeWalker(el, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
    acceptNode(n: Node): number {
      if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toUpperCase();
        const ce = e.getAttribute("contenteditable");
        if (
          SKIP_TAGS.has(tag) ||
          isPageChrome(e, tag) ||
          (ce !== null && ce !== "false") ||
          hiddenAttr(e) ||
          e.getAttribute("aria-hidden") === "true" ||
          SKIP_ROLES.has(e.getAttribute("role") ?? "") ||
          (view && hidesSubtree(e, view))
        ) {
          return NF.FILTER_REJECT;
        }
        if (BLOCK_TAGS.has(tag)) out.write("\n");
        return NF.FILTER_SKIP;
      }
      return NF.FILTER_ACCEPT;
    },
  });
  // visibility:hidden is inherited and overridable, so it is read from each
  // text node's parent; whitespace-only nodes skip the lookup.
  let lastParent: Element | null = null;
  let parentShown = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue ?? "";
    if (view && HAS_TEXT.test(v)) {
      const p = n.parentElement;
      if (p !== lastParent) {
        lastParent = p;
        const vis = p ? view.getComputedStyle(p).visibility : "visible";
        parentShown = vis !== "hidden" && vis !== "collapse";
      }
      if (!parentShown) continue;
    }
    if (!out.write(v)) break;
  }
  return { text: out.text, truncated: out.truncated };
}

function isEditable(el: Element): boolean {
  return !!el.closest(EDITABLE) || (el as HTMLElement).isContentEditable === true;
}

/** Hidden by attribute, or it or an ancestor hides its subtree with CSS. Collapsed sections do not count. */
function isHidden(el: Element): boolean {
  if (el.closest('[hidden]:not([hidden="until-found" i]), [aria-hidden="true"]')) return true;
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const chain: Element[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
  // Top-down, as the walker goes: hidesSubtree relies on the ancestors above having passed.
  return chain.some((e) => hidesSubtree(e, view));
}

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
  const body = boundedText(root, limits.bodyBytes);
  if (utf8Length(body.text) < MIN_BODY_BYTES) return { ok: false, reason: "no-content" };

  let rawTitle = (doc.title ?? "").replace(/\s+/g, " ").trim();
  let titleCut = false;
  if (!rawTitle) {
    const h1 = doc.querySelector("h1");
    if (h1) {
      const tt = boundedText(h1, limits.titleChars * 4);
      rawTitle = tt.text.replace(/\s+/g, " ");
      titleCut = tt.truncated;
    }
  }
  const title = truncateChars(rawTitle, limits.titleChars);
  return {
    ok: true,
    title: title.text,
    body: body.text,
    titleTruncated: title.truncated || titleCut,
    bodyTruncated: body.truncated,
  };
}
