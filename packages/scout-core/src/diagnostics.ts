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
  /** Injected for tests; defaults to fs.appendFileSync. */
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

const FORBIDDEN_FIELD = /^(url|text|title|prompt|context|token.*)$/i;
const RESERVED_FIELD = new Set(["t", "event"]);

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const append = options.appendFile ?? ((path: string, data: string) => appendFileSync(path, data));
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
          if (FORBIDDEN_FIELD.test(key) || RESERVED_FIELD.has(key)) {
            warn(`scout diagnostics: dropped field "${key}" on event "${name}"`);
            continue;
          }
          line[key] = value;
        }
        if (!dirReady) {
          mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
          dirReady = true;
        }
        append(options.path, `${JSON.stringify(line)}\n`);
      } catch {
        failures += 1;
      }
    },
  };
}
