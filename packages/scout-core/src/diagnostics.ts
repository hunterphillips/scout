import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Clock } from "./clock.js";

/**
 * Scalars only: event names, epochs, timings, counts, error codes. Never page text,
 * URLs beyond origin, prompts, context, or tokens.
 */
export type DiagnosticFields = Record<string, number | string | boolean>;

export interface Diagnostics {
  event(name: string, fields?: DiagnosticFields): void;
  /** Number of lines that failed to write. */
  readonly failures: number;
}

export interface DiagnosticsOptions {
  path: string;
  clock: Clock;
  /** Injected for tests; defaults to fs.appendFileSync, creating the file 0600. */
  appendFile?: (path: string, data: string) => void;
  /** Injected for tests; defaults to a stderr write. */
  warn?: (message: string) => void;
}

/** The ~/.scout root, overridable with SCOUT_HOME (same convention as the native host). */
export function scoutHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCOUT_HOME || join(homedir(), ".scout");
}

export function defaultDiagnosticsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(scoutHome(env), "logs", "diagnostics.jsonl");
}

/** Any key containing one of these fragments is dropped (pageUrl, hrefs, pageText, tokenCount). */
const FORBIDDEN_FRAGMENT = /url|href|text|title|prompt|token/i;
/** Dropped only as an exact key, so contextRevision passes. */
const FORBIDDEN_EXACT = /^context$/i;
const RESERVED_FIELD = new Set(["t", "event"]);
export const MAX_STRING_FIELD = 64;

/** Why a field is dropped, or null to keep it. */
function dropReason(key: string, value: number | string | boolean): string | null {
  if (RESERVED_FIELD.has(key)) return "reserved";
  // "context" contains "text"; strip it so contextRevision is judged on its other parts.
  if (FORBIDDEN_EXACT.test(key) || FORBIDDEN_FRAGMENT.test(key.replace(/context/gi, ""))) return "name";
  if (typeof value === "string" && key !== "origin" && value.includes("://")) return "value";
  return null;
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const append =
    options.appendFile ?? ((path: string, data: string) => appendFileSync(path, data, { mode: 0o600 }));
  const warn = options.warn ?? ((message: string) => void process.stderr.write(`${message}\n`));
  let dirReady = false;
  let failures = 0;

  return {
    get failures() {
      return failures;
    },
    event(name, fields = {}) {
      try {
        const line: Record<string, number | string | boolean> = { t: options.clock.now(), event: name };
        for (const [key, value] of Object.entries(fields)) {
          if (dropReason(key, value) !== null) {
            warn(`scout diagnostics: dropped field "${key}" on event "${name}"`);
            continue;
          }
          line[key] = typeof value === "string" && value.length > MAX_STRING_FIELD ? value.slice(0, MAX_STRING_FIELD) : value;
        }
        if (!dirReady) {
          mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
          dirReady = true;
        }
        append(options.path, `${JSON.stringify(line)}\n`);
      } catch {
        // Re-check the directory next time, so a deleted log dir recovers.
        dirReady = false;
        failures += 1;
      }
    },
  };
}
