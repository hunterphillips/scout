import { createHash } from "node:crypto";

/**
 * Acceptance rules for fetched website text (P2.2). Pure: bytes in, verdict out.
 *
 * The body decides, not the publisher's Content-Type: static hosts mislabel files, and a
 * single-page app answers every path with its `index.html`. A declared `text/html` is
 * still enough to refuse, but a declared `text/markdown` never rescues an HTML page.
 */

/** What is being validated. `skills_index` is JSON; this checks its encoding only and `skillsIndex.ts` its shape. */
export type TextKind = "llms_txt" | "agents_md" | "skill" | "skills_index";

/** Caps per kind, in raw bytes. */
export const TEXT_MAX_BYTES: Readonly<Record<TextKind, number>> = {
  llms_txt: 128 * 1024,
  agents_md: 128 * 1024,
  skills_index: 64 * 1024,
  skill: 64 * 1024,
};

/**
 * Why a body was refused. `too_large` is a limit (shown as `limited`); every other reason
 * says the content is not something Scout accepts (shown as `unsupported`).
 */
export type TextRejectReason =
  | "too_large"
  | "empty"
  | "nul_byte"
  | "invalid_utf8"
  | "binary"
  | "html"
  | "frontmatter_invalid"
  | "frontmatter_executable";

export type TextValidation =
  | {
      ok: true;
      /** The decoded text, exactly as served (a leading BOM is kept, so it re-encodes to the same bytes). */
      text: string;
      /** Lowercase hex SHA-256 of the raw bytes. */
      sha256: string;
      byteLength: number;
    }
  | { ok: false; reason: TextRejectReason };

/** Characters of the body (after a BOM and leading whitespace) searched for HTML markers. */
export const HTML_SCAN_CHARS = 1024;

/** Above this share of control characters (other than tab, LF, CR, FF) the body counts as binary. */
export const BINARY_CONTROL_RATIO = 0.01;

/**
 * Frontmatter keys that would make a skill do more than give instructions. Matched after
 * lowercasing and turning `_` into `-`. Scout's wrapper never passes these through, so a
 * skill carrying one is refused rather than silently stripped.
 */
export const EXECUTABLE_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(["hooks", "allowed-tools", "tools", "model", "mcp-servers", "mcpservers"]);

/** Most frontmatter lines examined before the block counts as unterminated. */
const FRONTMATTER_MAX_LINES = 64;

const HTML_MARKERS = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]/i;
/** A tag, comment, doctype, or processing instruction as the very first thing in the body. */
const LEADING_TAG = /^<(?:[a-z][a-z0-9-]*[\s/>]|!|\?)/i;
const FRONTMATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/html" || essence === "application/xhtml+xml";
}

function looksBinary(text: string): boolean {
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) || c === 0x7f) control += 1;
  }
  return control > 0 && control / text.length > BINARY_CONTROL_RATIO;
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, HTML_SCAN_CHARS);
  return LEADING_TAG.test(head) || HTML_MARKERS.test(head);
}

/**
 * Check a `SKILL.md`-shaped document: optional frontmatter of simple `key: value` lines
 * between `---` fences, then a non-empty Markdown body. Nested YAML, block scalars,
 * unterminated fences, and executable keys are refused.
 */
function checkSkill(body: string): TextRejectReason | null {
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return body.trim() ? null : "empty";
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES + 1); i++) {
    if (lines[i]?.trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return "frontmatter_invalid";
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) return "frontmatter_invalid";
    const colon = line.indexOf(":");
    if (colon < 0) return "frontmatter_invalid";
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!FRONTMATTER_KEY.test(key)) return "frontmatter_invalid";
    if (EXECUTABLE_FRONTMATTER_KEYS.has(key.toLowerCase().replace(/_/g, "-"))) return "frontmatter_executable";
    if (/^[|>]/.test(value)) return "frontmatter_invalid";
  }
  return lines.slice(end + 1).join("\n").trim() ? null : "empty";
}

/**
 * Accept `bytes` as text of `kind`, or say why not. Order: size cap, NUL bytes, strict
 * UTF-8, emptiness, binary control-character ratio, HTML (declared `text/html`, a leading
 * tag, or an HTML marker in the first `HTML_SCAN_CHARS`), then the `SKILL.md` shape for skills.
 */
export function validateText(bytes: Uint8Array, declaredContentType: string | undefined, kind: TextKind, maxBytes: number = TEXT_MAX_BYTES[kind]): TextValidation {
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
  if (bytes.includes(0)) return { ok: false, reason: "nul_byte" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
  const body = text.replace(/^﻿/, "").trimStart();
  if (!body) return { ok: false, reason: "empty" };
  if (looksBinary(text)) return { ok: false, reason: "binary" };
  if (isHtmlContentType(declaredContentType) || looksLikeHtml(body)) return { ok: false, reason: "html" };
  if (kind === "skill") {
    const reason = checkSkill(body);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, text, sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}
