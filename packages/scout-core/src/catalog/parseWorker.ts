// The core's catalog parse worker: sitemap and llms.txt parsing (up to 2 MiB of XML and 50,000
// entries per file) runs in one `worker_threads` Worker, so the coordinator keeps processing
// focus, pause and grant frames while a large catalog is parsed. A pool of one: parses run one
// at a time, in order. The parsers stay pure (sitemap.ts, llmsTxt.ts); the worker only calls
// them.
//
// `cancel()` terminates the worker and rejects every parse queued or running with
// ParseCancelledError; the next parse starts a fresh worker. The core calls it when a discovery
// pass's fetch session is cancelled (pause, permission loss, disconnect, stop). `close()` is for
// shutdown: it terminates the worker and refuses every later parse.
//
// `scope(isCancelled)` gives one discovery pass its own parsers: a parse submitted once
// `isCancelled()` is true (the pass's fetch session was cancelled) or after the scope's own
// `cancel()` is refused with ParseCancelledError before it reaches the queue, so a cancelled
// pass can never occupy the single worker; `cancel()` fails only that pass's queued parses
// and, when the running parse is the pass's, terminates the worker (the queue goes on in a
// fresh one). Another pass's parses are left alone.
//
// A parse that overruns PARSE_MAX_MS fails alone with ParseTimeoutError (`parse_timeout`): its
// stuck worker is terminated and the queue goes on in a fresh one.
//
// A worker that fails to start or dies (not a cancel) fails the parse it held with
// ParseWorkerUnavailableError and reports `parse_worker_unavailable {code}` once per pool:
// `start_failed` (the constructor threw), `worker_error` (an uncaught error, e.g. a missing
// entrypoint), `worker_exit` (it exited on its own). Fail closed: there is no inline fallback,
// so a parse never runs on the main thread; the next parse tries a fresh worker.

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Diagnostics } from "../diagnostics.js";
import type { ParsedLlmsTxt } from "./llmsTxt.js";
import type { CatalogParsers } from "./resolver.js";
import type { ParsedSitemap } from "./sitemap.js";

/** Upper bound on one parse in the worker. */
export const PARSE_MAX_MS = 10_000;

export class ParseCancelledError extends Error {
  readonly code = "parse_cancelled";
  constructor() {
    super("parse cancelled");
    this.name = "ParseCancelledError";
  }
}

export class ParseTimeoutError extends Error {
  readonly code = "parse_timeout";
  constructor() {
    super("parse timed out");
    this.name = "ParseTimeoutError";
  }
}

export type ParseWorkerUnavailableCode = "start_failed" | "worker_error" | "worker_exit";

export class ParseWorkerUnavailableError extends Error {
  readonly code = "parse_worker_unavailable";
  constructor(readonly reason: ParseWorkerUnavailableCode) {
    super(`parse worker unavailable: ${reason}`);
    this.name = "ParseWorkerUnavailableError";
  }
}

export function defaultParseWorkerEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-core/catalog/parse-worker");
}

/** One discovery pass's view of the pool (see the header). */
export interface ParseScope {
  readonly parsers: CatalogParsers;
  /** Fail this scope's queued and running parses, and refuse its later ones. Idempotent. */
  cancel(): void;
}

export interface ParsePool {
  readonly parsers: CatalogParsers;
  /** Parsers for one pass; refused once `isCancelled()` is true or the scope is cancelled. */
  scope(isCancelled?: () => boolean): ParseScope;
  /** Terminate the worker; every queued or running parse rejects with ParseCancelledError. */
  cancel(): void;
  /** Cancel, refuse parses from now on, and resolve once the worker's thread has stopped. */
  close(): Promise<void>;
  /** Parses queued or running. */
  readonly pending: number;
}

type Job = { kind: "sitemap"; text: string; origin: string } | { kind: "llms"; text: string; origin: string; baseUrl: string };

interface Queued {
  id: number;
  job: Job;
  /** The scope that submitted it, if any. */
  owner?: object;
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
}

export function createParsePool(options: { entrypoint?: string; maxMs?: number; diagnostics?: Pick<Diagnostics, "event"> } = {}): ParsePool {
  const maxMs = options.maxMs ?? PARSE_MAX_MS;
  let reported = false;
  const unavailable = (code: ParseWorkerUnavailableCode): ParseWorkerUnavailableError => {
    if (!reported) {
      reported = true;
      options.diagnostics?.event("parse_worker_unavailable", { code });
    }
    return new ParseWorkerUnavailableError(code);
  };
  let worker: Worker | null = null;
  let running: (Queued & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const queue: Queued[] = [];
  let nextId = 0;
  let closed = false;

  const fail = (q: Queued, e: unknown): void => q.reject(e);

  /** Terminate the current worker; resolves once its thread has stopped. */
  const dropWorker = (): Promise<void> => {
    const w = worker;
    worker = null;
    if (w === null) return Promise.resolve();
    w.removeAllListeners();
    return w.terminate().then(
      () => {},
      () => {},
    );
  };

  const cancelAll = (): Promise<void> => {
    const victims = [...(running ? [running] : []), ...queue.splice(0)];
    if (running) clearTimeout(running.timer);
    running = null;
    const stopped = dropWorker();
    for (const q of victims) fail(q, new ParseCancelledError());
    return stopped;
  };

  /** The running parse overran its bound: fail it alone, drop its stuck worker, go on with the queue. */
  const timedOut = (r: Queued): void => {
    if (running === null || running.id !== r.id) return;
    running = null;
    void dropWorker();
    r.reject(new ParseTimeoutError());
    pump();
  };

  const ensureWorker = (): Worker => {
    if (worker !== null) return worker;
    const w = new Worker(options.entrypoint ?? defaultParseWorkerEntrypoint(), { execArgv: [] });
    w.unref();
    w.on("message", (msg: { id: number; ok: boolean; result?: unknown }) => {
      const r = running;
      if (r === null || msg.id !== r.id) return;
      clearTimeout(r.timer);
      running = null;
      if (msg.ok) r.resolve(msg.result);
      else r.reject(new Error("parse failed"));
      pump();
    });
    // A worker that dies takes its running parse with it; queued ones go to a fresh worker.
    const died = (code: ParseWorkerUnavailableCode): void => {
      if (worker !== w) return;
      worker = null;
      w.removeAllListeners();
      void w.terminate().catch(() => {});
      const r = running;
      running = null;
      const err = unavailable(code);
      if (r !== null) {
        clearTimeout(r.timer);
        r.reject(err);
      }
      pump();
    };
    w.on("error", () => died("worker_error"));
    w.on("exit", () => died("worker_exit"));
    worker = w;
    return w;
  };

  const pump = (): void => {
    if (running !== null || closed) return;
    const next = queue.shift();
    if (next === undefined) return;
    let w: Worker;
    try {
      w = ensureWorker();
    } catch {
      next.reject(unavailable("start_failed"));
      pump();
      return;
    }
    const entry = { ...next, timer: setTimeout(() => timedOut(entry), maxMs) };
    entry.timer.unref();
    running = entry;
    w.postMessage({ id: next.id, ...next.job });
  };

  const submit = <T>(job: Job, owner?: object): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new ParseCancelledError());
        return;
      }
      queue.push({ id: ++nextId, job, resolve: resolve as (v: unknown) => void, reject, ...(owner ? { owner } : {}) });
      pump();
    });

  /** Fail `owner`'s parses only; a running one takes its worker with it and the queue goes on. */
  const cancelOwner = (owner: object): void => {
    const victims: Queued[] = [];
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.owner === owner) victims.unshift(...queue.splice(i, 1));
    const r = running;
    if (r !== null && r.owner === owner) {
      clearTimeout(r.timer);
      running = null;
      void dropWorker();
      victims.unshift(r);
    }
    for (const q of victims) fail(q, new ParseCancelledError());
    pump();
  };

  const scope = (isCancelled: () => boolean = () => false): ParseScope => {
    const owner = {};
    let cancelled = false;
    const refused = (): boolean => cancelled || isCancelled();
    const guarded = <T>(job: Job): Promise<T> => (refused() ? Promise.reject(new ParseCancelledError()) : submit<T>(job, owner));
    return {
      parsers: {
        sitemap: (xml, origin) => guarded<ParsedSitemap>({ kind: "sitemap", text: xml, origin }),
        llmsTxt: (text, origin, baseUrl) => guarded<ParsedLlmsTxt>({ kind: "llms", text, origin, baseUrl }),
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        cancelOwner(owner);
      },
    };
  };

  return {
    parsers: {
      sitemap: (xml, origin) => submit<ParsedSitemap>({ kind: "sitemap", text: xml, origin }),
      llmsTxt: (text, origin, baseUrl) => submit<ParsedLlmsTxt>({ kind: "llms", text, origin, baseUrl }),
    },
    scope,
    cancel: () => void cancelAll(),
    async close() {
      closed = true;
      // The worker's thread is gone on return.
      await cancelAll();
    },
    get pending() {
      return queue.length + (running ? 1 : 0);
    },
  };
}
