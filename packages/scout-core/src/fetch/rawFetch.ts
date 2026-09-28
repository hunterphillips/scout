import { Readable } from "node:stream";
import { request, type Dispatcher } from "undici";

/** The request shape guarded fetch hands to its transport. */
export interface GuardedRequestInit {
  method: "GET";
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
  /** Routes the connection through the pinned DNS answer. */
  dispatcher: Dispatcher;
}

/** Transport for guarded fetch; tests inject fakes returning `Response` objects. */
export type FetchLike = (url: string, init: GuardedRequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Thrown by the transport for a status `Response` cannot represent (outside 200-599).
 * Guarded fetch reports it as an `http` error carrying the status, not a network failure.
 */
export class UnexpectedStatusError extends Error {
  constructor(readonly status: number) {
    super(`Unexpected status ${status}`);
    this.name = "UnexpectedStatusError";
  }
}

/**
 * One HTTP exchange through undici's `request`, returned as a `Response` whose body is
 * the bytes on the wire, still content-encoded.
 *
 * Why not undici's `fetch`: it always decodes `Content-Encoding` and has no switch to
 * turn that off, so the decoded-size cap would have to trust its buffering. With the
 * raw bytes, guarded fetch runs its own streaming decoder and counts every decoded byte.
 * `request` does not follow redirects, which leaves hop policy to guarded fetch.
 */
export const rawFetch: FetchLike = async (url, init) => {
  const response = await request(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    dispatcher: init.dispatcher,
  });
  if (response.statusCode < 200 || response.statusCode > 599) {
    await response.body.dump();
    throw new UnexpectedStatusError(response.statusCode);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  if (NULL_BODY_STATUSES.has(response.statusCode)) {
    await response.body.dump();
    return new Response(null, { status: response.statusCode, headers });
  }
  // Readable.toWeb honours backpressure here (verified on Node 24): the socket is read only as the decoder pulls.
  const body = Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
  return new Response(body, { status: response.statusCode, headers });
};
