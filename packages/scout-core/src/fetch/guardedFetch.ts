// Adapted from rookkeeper/rook server/src/infrastructure/http/guardedFetch.ts (Rook, by John
// Berryman / Arcturus Labs). Scout changes: Scout user agent; the screened DNS answer is
// pinned for the connection (undici Agent with a pinned `connect.lookup`), so DNS rebinding
// is in scope; `Accept-Encoding: gzip, br` with a streaming decoder capped on decoded bytes;
// transport is undici `request` (raw bytes) instead of global fetch; 8 s timeout; 2 MiB cap.

import { lookup as dnsLookup } from "node:dns/promises";
import { SCOUT_VERSION } from "../version.js";
import { ACCEPT_ENCODING, readDecodedBody } from "./decodedBody.js";
import { isDisallowedAddress } from "./ipAddressPolicy.js";
import type { Dispatcher } from "undici";
import { createPinnedDispatcher, type ScreenedAddress } from "./pinnedDispatcher.js";
import { type FetchLike, rawFetch, UnexpectedStatusError } from "./rawFetch.js";

/**
 * Guarded outbound HTTP for public HTTPS resources.
 *
 * Policy: `https:` only; the hostname must not resolve to any address refused by
 * `isDisallowedAddress` (loopback, private, link-local, CGNAT, multicast, ...); redirects are followed only to the same host and
 * only up to a hop limit; one deadline covers the whole call (DNS, every hop, and the
 * body read); responses have a size cap on decoded bytes and a fixed `User-Agent`.
 * Policy and network conditions are returned as `error` results rather than thrown.
 *
 * DNS is resolved and screened once per call, and every connection in the call uses
 * only those screened addresses, so a later DNS answer cannot redirect it to a private
 * address (DNS rebinding).
 *
 * Bodies retain their exact decoded bytes alongside UTF-8 text. A leading BOM is
 * preserved in `body`; invalid UTF-8 is decoded with the standard replacement character.
 */

export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_ACCEPT = "text/plain, text/markdown, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1";

/** Fixed identifier sent on every guarded request. */
export const SCOUT_USER_AGENT = `Scout/${SCOUT_VERSION}`;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** DNS resolver shape — matches `dns.promises.lookup(hostname, { all: true })`. */
export type HostLookup = (hostname: string) => Promise<ScreenedAddress[]>;

export type { FetchLike, GuardedRequestInit } from "./rawFetch.js";

/** Builds the per-call dispatcher that pins connections to the screened addresses. */
export type DispatcherFactory = (hostname: string, addresses: ScreenedAddress[]) => Dispatcher;

/**
 * Test-only replacements for the transport and address policy. Internal: passed to
 * `createGuardedFetch`, never through the public options, and not exported from the
 * package entry point.
 */
export interface GuardedFetchHooks {
  /** Defaults to undici `request` through the pinned dispatcher. */
  fetch?: FetchLike;
  /** Defaults to `dns.promises.lookup` with `{ all: true }`. */
  lookup?: HostLookup;
  /** The address policy. Defaults to `isDisallowedAddress`; only tests that talk to a loopback server override it. */
  isDisallowed?: (address: string) => boolean;
  /**
   * Builds the pinned dispatcher. Defaults to `createPinnedDispatcher`; tests use it to
   * trust a self-signed certificate. It must still pin to `addresses`.
   */
  dispatcherFactory?: DispatcherFactory;
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  /** Cap on decoded body bytes. */
  maxBytes?: number;
  maxRedirects?: number;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  accept?: string;
}

export type GuardedFetchErrorReason = "policy" | "timeout" | "too_large" | "network" | "http";

export type GuardedFetchResult =
  | { kind: "ok"; status: number; body: string; bytes: Uint8Array; etag?: string; lastModified?: string; contentType?: string; finalUrl: string }
  | { kind: "not_modified"; etag?: string; lastModified?: string }
  | { kind: "absent"; status: number }
  /**
   * `message` is for local logs and tests only. It may contain the full URL (path and
   * query), so it must never be written to diagnostics, which carry the origin only.
   */
  | { kind: "error"; reason: GuardedFetchErrorReason; status?: number; message: string };

function fail(reason: GuardedFetchErrorReason, message: string, status?: number): GuardedFetchResult {
  return status === undefined ? { kind: "error", reason, message } : { kind: "error", reason, status, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Header value, or nothing when absent (keeps `exactOptionalPropertyTypes` happy). */
function optionalHeader<K extends string>(response: Response, header: string, key: K): { [P in K]?: string } {
  const value = response.headers.get(header);
  return (value === null ? {} : { [key]: value }) as { [P in K]?: string };
}

/** Hostname without IPv6 brackets, lowercased. */
function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Discard an unread body. Cancelling destroys the body and its socket, so the next hop
 * opens a fresh connection; that costs little because the dispatcher is per call.
 */
async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A locked or already-errored body is already on its way down; nothing to do.
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("deadline reached"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("deadline reached")), { once: true });
  });
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true });

export type GuardedFetch = (url: string, options?: GuardedFetchOptions) => Promise<GuardedFetchResult>;

/** A `guardedFetch` with test hooks bound. Internal: tests use it; production code uses `guardedFetch`. */
export function createGuardedFetch(hooks: GuardedFetchHooks): GuardedFetch {
  return (url, options = {}) => guardedFetchWith(hooks, url, options);
}

/** Fetch a public HTTPS resource under the policy documented at the top of this module. */
export const guardedFetch: GuardedFetch = createGuardedFetch({});

async function guardedFetchWith(hooks: GuardedFetchHooks, url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const doFetch = hooks.fetch ?? rawFetch;
  const lookup = hooks.lookup ?? defaultLookup;
  const isDisallowed = hooks.isDisallowed ?? isDisallowedAddress;
  const dispatcherFactory: DispatcherFactory = hooks.dispatcherFactory ?? createPinnedDispatcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const headers: Record<string, string> = {
    "user-agent": SCOUT_USER_AGENT,
    accept: options.accept ?? DEFAULT_ACCEPT,
    "accept-encoding": ACCEPT_ENCODING,
  };
  if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
  if (options.ifModifiedSince) headers["if-modified-since"] = options.ifModifiedSince;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fail("policy", `Not a valid URL: ${url}`);
  }
  const originHost = target.host.toLowerCase();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let dispatcher: Dispatcher | null = null;

  try {
    for (let hop = 0; ; hop += 1) {
      // The deadline is enforced here too, so an injected fetch that ignores the abort
      // signal cannot keep the redirect loop alive past it.
      if (timedOut) return fail("timeout", `Request to ${url} timed out after ${timeoutMs}ms`);
      if (target.protocol !== "https:") return fail("policy", `Only https: URLs are allowed, got ${target.protocol}//`);
      const hostname = hostnameOf(target);
      if (!hostname) return fail("policy", `URL has no hostname: ${target.href}`);
      if (target.host.toLowerCase() !== originHost) {
        return fail("policy", `Redirect to a different host is not allowed: ${originHost} -> ${target.host.toLowerCase()}`);
      }

      // Redirects never leave the host, so one lookup screens every hop, and the pinned
      // dispatcher makes every hop connect to exactly those screened addresses.
      if (!dispatcher) {
        let addresses: ScreenedAddress[];
        try {
          addresses = await Promise.race([lookup(hostname), rejectOnAbort(controller.signal)]);
        } catch (cause) {
          if (timedOut) return fail("timeout", `DNS lookup for ${hostname} timed out after ${timeoutMs}ms`);
          return fail("network", `DNS lookup failed for ${hostname}: ${errorMessage(cause)}`);
        }
        if (addresses.length === 0) return fail("network", `DNS lookup returned no addresses for ${hostname}`);
        const disallowed = addresses.find((entry) => isDisallowed(entry.address));
        if (disallowed) return fail("policy", `${hostname} resolves to a disallowed address: ${disallowed.address}`);
        dispatcher = dispatcherFactory(hostname, addresses);
      }

      let response: Response;
      try {
        response = await doFetch(target.toString(), { method: "GET", redirect: "manual", signal: controller.signal, headers, dispatcher });
      } catch (cause) {
        if (timedOut) return fail("timeout", `Request to ${target.href} timed out after ${timeoutMs}ms`);
        if (cause instanceof UnexpectedStatusError) return fail("http", `Unexpected status ${cause.status} from ${target.href}`, cause.status);
        return fail("network", `Request to ${target.href} failed: ${errorMessage(cause)}`);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await drain(response);
        const location = response.headers.get("location");
        if (!location) return fail("http", `Redirect ${response.status} from ${target.href} had no Location header`, response.status);
        if (hop >= maxRedirects) return fail("policy", `Exceeded the redirect limit of ${maxRedirects} for ${url}`);
        try {
          target = new URL(location, target);
        } catch {
          return fail("policy", `Redirect target is not a valid URL: ${location}`);
        }
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        await drain(response); // no non-2xx body is consumed
        if (response.status === 304) {
          return { kind: "not_modified", ...optionalHeader(response, "etag", "etag"), ...optionalHeader(response, "last-modified", "lastModified") };
        }
        if (response.status === 404 || response.status === 410) return { kind: "absent", status: response.status };
        return fail("http", `Unexpected status ${response.status} from ${target.href}`, response.status);
      }

      let read: Awaited<ReturnType<typeof readDecodedBody>>;
      try {
        read = await readDecodedBody(response.body, response.headers.get("content-encoding"), maxBytes, controller.signal);
      } catch (cause) {
        if (timedOut) return fail("timeout", `Reading ${target.href} timed out after ${timeoutMs}ms`);
        return fail("network", `Reading ${target.href} failed: ${errorMessage(cause)}`);
      }
      if (read.kind === "too_large") return fail("too_large", `Response from ${target.href} exceeded ${maxBytes} decoded bytes`);
      if (read.kind === "unsupported") return fail("http", `Unsupported content-encoding ${read.coding} from ${target.href}`, response.status);

      return {
        kind: "ok",
        status: response.status,
        // `ignoreBOM` keeps a leading BOM in the decoded text instead of swallowing it.
        body: new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.bytes),
        bytes: read.bytes,
        ...optionalHeader(response, "etag", "etag"),
        ...optionalHeader(response, "last-modified", "lastModified"),
        ...optionalHeader(response, "content-type", "contentType"),
        finalUrl: target.toString(),
      };
    }
  } finally {
    clearTimeout(timer);
    // Every body has been read or cancelled by now; destroying closes any kept-alive socket.
    void dispatcher?.destroy().catch(() => undefined);
  }
}
