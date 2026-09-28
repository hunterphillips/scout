#!/usr/bin/env node
// Scout Phase 0: minimal read-only STDIO MCP server named `sources`, serving a
// synthetic fixture for the agent retrieval smoke.
//
//   node fixture-source-server.mjs <runDir> [--delay-ms <0..5000>]
//
// Serves <runDir>/fixture-root only. Appends audit records to
// <runDir>/audit.jsonl: tool name, args hash, evidence ids, served fixture
// paths, byte counts and timing, plus lifecycle events. Never raw content or
// queries. stdout carries MCP protocol only; stderr carries fixed diagnostics.
// No writes (other than the audit file), no network, no shell.
// Exits on stdin EOF, on a changed parent (orphaned), or on SIGTERM/SIGINT/SIGHUP.

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const LIMITS = Object.freeze({
  maxCalls: 20,
  maxTotalBytes: 128 * 1024,
  maxReadBytes: 16 * 1024,
  maxSearchHits: 5,
  maxSnippetBytes: 600,
  maxDocs: 200,
  maxDepth: 4,
  maxDelayMs: 5000,
});

const SOURCE_ID = "fixture-notes";

// Protocol-only stdout: nothing in this process may print to it by accident.
console.log = () => {};
console.info = () => {};

function diag(msg) {
  // Fixed metadata strings only; never paths, content or queries.
  process.stderr.write(`sources: ${msg}\n`);
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function hashArgs(args) {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16);
}

function truncateBytes(text, max) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  // Cut on a character boundary.
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function parseServerArgs(argv) {
  const [runDir, ...rest] = argv;
  if (typeof runDir !== "string" || !isAbsolute(runDir)) return { error: "usage: <absolute runDir> [--delay-ms n]" };
  let delayMs = 0;
  if (rest.length === 2 && rest[0] === "--delay-ms" && /^\d{1,4}$/.test(rest[1]) && Number(rest[1]) <= LIMITS.maxDelayMs) {
    delayMs = Number(rest[1]);
  } else if (rest.length !== 0) {
    return { error: "usage: <absolute runDir> [--delay-ms n]" };
  }
  return { runDir, delayMs };
}

/** Everything the tools need, with no protocol attached (the server wraps it). */
export function createSourceState({ runDir, delayMs = 0 }) {
  const rootReal = realpathSync.native(join(runDir, "fixture-root"));
  const auditPath = join(runDir, "audit.jsonl");
  const state = { calls: 0, bytes: 0, nextEvidence: 1, timers: new Set() };

  function audit(record) {
    appendFileSync(auditPath, JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  /** Regular .md files under the root, never following symlinks. */
  function listDocs() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > LIMITS.maxDepth) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= LIMITS.maxDocs) return;
        const abs = join(dir, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(abs, depth + 1);
        else if (ent.isFile() && ent.name.endsWith(".md")) out.push(relative(rootReal, abs).split(sep).join("/"));
      }
    };
    walk(rootReal, 0);
    return out.sort();
  }

  /** Physical containment: absolute, `..` and symlink escapes all end here. */
  function resolveDoc(rel) {
    if (typeof rel !== "string" || rel.length === 0 || rel.length > 256 || rel.includes("\0")) return null;
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return null;
    let real;
    try {
      real = realpathSync.native(join(rootReal, rel));
    } catch {
      return null;
    }
    if (!isInside(real, rootReal) || real === rootReal) return null;
    try {
      if (!statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    return { real, rel: relative(rootReal, real).split(sep).join("/") };
  }

  function readCapped(real, max) {
    const fd = openSync(real, "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, max + 4));
      const n = readSync(fd, buf, 0, buf.length, 0);
      const { text, truncated } = truncateBytes(buf.subarray(0, n).toString("utf8"), max);
      return { text, truncated: truncated || size > max };
    } finally {
      closeSync(fd);
    }
  }

  function delay(signal) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, delayMs);
      state.timers.add(t);
      function done() {
        clearTimeout(t);
        state.timers.delete(t);
        signal?.removeEventListener?.("abort", done);
        resolve();
      }
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  const handlers = {
    list_sources() {
      const documents = listDocs().map((path) => ({ path, bytes: statSync(join(rootReal, path)).size }));
      return {
        payload: {
          sources: [{ sourceId: SOURCE_ID, description: "Synthetic project notes (read-only fixture)", documents }],
          note: "Catalog metadata is not evidence. Use search_source or read_source to get citable evidence ids.",
        },
        evidenceIds: [],
        docs: [],
      };
    },
    search_source({ query }) {
      const terms = [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))].slice(0, 8);
      const scored = [];
      for (const path of listDocs()) {
        const doc = resolveDoc(path);
        if (!doc) continue;
        const { text } = readCapped(doc.real, LIMITS.maxReadBytes);
        for (const para of text.split(/\n\s*\n/)) {
          const lower = para.toLowerCase();
          const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
          if (score > 0) scored.push({ path: doc.rel, para: para.trim(), score });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const results = scored.slice(0, LIMITS.maxSearchHits).map((h) => ({
        evidenceId: `e${state.nextEvidence++}`,
        path: h.path,
        snippet: truncateBytes(h.para, LIMITS.maxSnippetBytes).text,
      }));
      return {
        payload: { sourceId: SOURCE_ID, results },
        evidenceIds: results.map((r) => r.evidenceId),
        docs: [...new Set(results.map((r) => r.path))],
      };
    },
    read_source({ path }) {
      const doc = resolveDoc(path);
      if (!doc) return { denied: true };
      const { text, truncated } = readCapped(doc.real, LIMITS.maxReadBytes);
      const evidenceId = `e${state.nextEvidence++}`;
      return { payload: { sourceId: SOURCE_ID, evidenceId, path: doc.rel, truncated, content: text }, evidenceIds: [evidenceId], docs: [doc.rel] };
    },
  };

  /** Run one tool call under the budgets, auditing it. Returns an MCP CallToolResult. */
  async function call(tool, args, signal) {
    const startedAt = new Date();
    const t0 = performance.now();
    const rec = { type: "tool_call", seq: state.calls + 1, tool, argsHash: hashArgs(args), at: startedAt.toISOString() };
    const finish = (outcome, result, extra = {}) => {
      const bytes = result.content.reduce((n, c) => n + Buffer.byteLength(c.text ?? "", "utf8"), 0);
      audit({ ...rec, outcome, evidenceIds: extra.evidenceIds ?? [], docs: extra.docs ?? [], bytes, durationMs: Math.round(performance.now() - t0) });
      return result;
    };
    const error = (text) => ({ content: [{ type: "text", text }], isError: true });

    if (state.calls >= LIMITS.maxCalls) return finish("budget", error("budget exhausted: tool-call limit reached"));
    state.calls++;
    await delay(signal);
    if (signal?.aborted) return finish("cancelled", error("cancelled"));
    let out;
    try {
      out = handlers[tool](args ?? {});
    } catch {
      return finish("error", error("internal error"));
    }
    if (out.denied) return finish("denied", error("denied: path is not a document inside the granted source"));
    const text = JSON.stringify(out.payload);
    const bytes = Buffer.byteLength(text, "utf8");
    if (state.bytes + bytes > LIMITS.maxTotalBytes) {
      // Evidence ids minted for a response that is never sent stay unused.
      return finish("budget", error("budget exhausted: returned-bytes limit reached"));
    }
    state.bytes += bytes;
    return finish("ok", { content: [{ type: "text", text }] }, out);
  }

  function clearTimers() {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
  }

  return { call, audit, clearTimers, state };
}

export async function startServer({ runDir, delayMs }) {
  const src = createSourceState({ runDir, delayMs });
  const server = new McpServer({ name: "sources", version: "0.0.1" });
  const ro = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };

  server.registerTool(
    "list_sources",
    { description: "List the granted sources and their documents. Metadata only; not citable evidence.", inputSchema: {}, annotations: ro },
    (_args, extra) => src.call("list_sources", {}, extra?.signal),
  );
  server.registerTool(
    "search_source",
    {
      description: "Search the granted source. Returns short snippets, each with a citable evidence id.",
      inputSchema: { query: z.string().min(1).max(200) },
      annotations: ro,
    },
    (args, extra) => src.call("search_source", args, extra?.signal),
  );
  server.registerTool(
    "read_source",
    {
      description: "Read one document from the granted source by its relative path (max 16 KiB). Returns a citable evidence id.",
      inputSchema: { path: z.string().min(1).max(256) },
      annotations: ro,
    },
    (args, extra) => src.call("read_source", args, extra?.signal),
  );

  const initialPpid = process.ppid;
  let stopping = false;
  let orphanTimer;
  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    clearInterval(orphanTimer);
    src.clearTimers();
    try {
      src.audit({ type: "lifecycle", event: "exit", reason, pid: process.pid, at: new Date().toISOString() });
    } catch {
      // audit dir already gone: nothing else to record
    }
    process.exit(0);
  };
  orphanTimer = setInterval(() => {
    if (process.ppid !== initialPpid) shutdown("orphaned");
  }, 250);
  process.stdin.on("end", () => shutdown("stdin_eof"));
  process.stdin.on("close", () => shutdown("stdin_eof"));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));

  src.audit({ type: "lifecycle", event: "start", pid: process.pid, ppid: initialPpid, delayMs, at: new Date().toISOString() });
  await server.connect(new StdioServerTransport());
  diag("ready");
  return { shutdown };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.on("uncaughtException", () => {
    diag("internal error");
    process.exit(1);
  });
  const args = parseServerArgs(process.argv.slice(2));
  if (args.error) {
    diag(args.error);
    process.exit(2);
  }
  startServer(args).catch(() => {
    diag("failed to start");
    process.exit(1);
  });
}
