import { DEFAULT_MAX_BYTES, type GuardedFetchResult } from "./guardedFetch.js";

/** The options a coalesced fetch understands; structurally the catalog's `CatalogFetchOptions`. */
export interface CoalescedFetchOptions {
  maxBytes?: number;
  accept?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export type CoalescibleFetch = (url: string, opts?: CoalescedFetchOptions) => Promise<GuardedFetchResult>;

/**
 * Root paths whose finished result stays shared for the life of a coalescing fetch (one
 * pass): both the catalog and capability discovery read them, usually not at the same
 * moment. Every other URL is shared only while its request is in flight, so large sitemap
 * bodies are not held after use.
 */
export const RETAINED_ROOT_PATHS: ReadonlySet<string> = new Set(["/robots.txt", "/llms.txt", "/AGENTS.md"]);

interface Pending {
  maxBytes: number;
  promise: Promise<GuardedFetchResult>;
}

function tooLarge(maxBytes: number): GuardedFetchResult {
  return { kind: "error", reason: "too_large", message: `Response exceeded ${maxBytes} decoded bytes` };
}

/**
 * Wrap `inner` so callers asking for the same resource share one request and one decoded
 * body. Requests match on URL, `Accept`, and both validators; the size cap is handled per
 * caller: a request in flight with a cap at least as large is shared, and an `ok` body over
 * this caller's smaller cap comes back to it as `too_large`. A caller with a larger cap than
 * the one in flight waits for it and reuses an `ok` answer (it fits), or makes its own
 * request if the smaller cap was what failed. Non-error results for `RETAINED_ROOT_PATHS`
 * are kept until the wrapper is dropped; everything else is forgotten once settled.
 *
 * Validators are part of the key, so a conditional request is shared only with callers
 * holding exactly the same ETag and Last-Modified. On a warm pass the catalog and resource
 * discovery share `/llms.txt` only because both store validators by the same rule
 * (`nextValidators`) and send the same `Accept`; a caller without validators (or with
 * other ones) makes its own request.
 */
export function createCoalescingFetch(inner: CoalescibleFetch): CoalescibleFetch {
  const pending = new Map<string, Pending>();

  const start = (key: string, url: string, opts: CoalescedFetchOptions, maxBytes: number, retain: boolean): Promise<GuardedFetchResult> => {
    const promise = inner(url, opts);
    const entry: Pending = { maxBytes, promise };
    pending.set(key, entry);
    const forget = () => {
      if (pending.get(key) === entry) pending.delete(key);
    };
    // Errors are never retained: a pacing refusal or a timeout must not answer a request
    // made later in the pass (after `startWindow` refilled the budget, say).
    promise.then((result) => {
      if (!retain || result.kind === "error") forget();
    }, forget);
    return promise;
  };

  return async (url, opts = {}) => {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const key = [url, opts.accept ?? "", opts.ifNoneMatch ?? "", opts.ifModifiedSince ?? ""].join("\n");
    let retain = false;
    try {
      retain = RETAINED_ROOT_PATHS.has(new URL(url).pathname);
    } catch {
      // Unparseable: the inner fetch refuses it.
    }
    for (let existing = pending.get(key); existing; ) {
      const shared = await existing.promise;
      if (existing.maxBytes >= maxBytes) return withinCap(shared, maxBytes);
      // A smaller cap was in flight: an `ok` body fits this caller too; a `too_large` one
      // says nothing about this caller's cap, so it asks again (or joins whoever already did).
      if (!(shared.kind === "error" && shared.reason === "too_large")) return shared;
      const next = pending.get(key);
      if (next === existing || (next && next.maxBytes < maxBytes)) break;
      existing = next;
    }
    return start(key, url, opts, maxBytes, retain);
  };
}

function withinCap(result: GuardedFetchResult, maxBytes: number): GuardedFetchResult {
  return result.kind === "ok" && result.bytes.byteLength > maxBytes ? tooLarge(maxBytes) : result;
}
