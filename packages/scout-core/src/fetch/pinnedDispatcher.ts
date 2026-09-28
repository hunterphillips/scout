import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent } from "undici";

/** An address that passed the IP policy, in the shape `dns.lookup` returns. */
export interface ScreenedAddress {
  address: string;
  family: number;
}

/** The callback shape `net.connect` calls to resolve a hostname. */
export type ConnectLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * A `net.connect` lookup that answers from the addresses screened before the request and
 * never asks DNS again. This is what defeats DNS rebinding: a second DNS answer that
 * points at a private address is never consulted. It answers only for the screened
 * hostname and fails the connection when there is nothing to pin. When the caller asks
 * for one address family, only pinned addresses of that family are offered; if none
 * match, the connection fails rather than falling back to DNS.
 */
export function createPinnedLookup(hostname: string, addresses: readonly ScreenedAddress[]): ConnectLookup {
  const pinnedHost = hostname.toLowerCase();
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (requested, options, callback) => {
    if (requested.toLowerCase() !== pinnedHost) {
      callback(lookupError(`No pinned addresses for ${requested}`), []);
      return;
    }
    const family = requestedFamily(options.family);
    const offered = family ? pinned.filter((entry) => entry.family === family) : pinned;
    const first = offered[0];
    if (!first) {
      const which = family ? `IPv${family} ` : "";
      callback(lookupError(`No pinned ${which}addresses for ${requested}`), []);
      return;
    }
    if (options.all) callback(null, offered);
    else callback(null, first.address, first.family);
  };
}

/** `dns.lookup` accepts 4, 6, 0, or the strings "IPv4" / "IPv6"; 0 means any. */
function requestedFamily(family: LookupOptions["family"]): 4 | 6 | null {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return null;
}

/**
 * Test hook: extra TLS options merged into the dispatcher's connect options, such as a
 * `ca` that trusts a test server's self-signed certificate. Production passes none.
 */
export interface PinnedTlsOptions {
  ca?: string | Buffer;
}

/**
 * An undici dispatcher whose connections resolve `hostname` only through the pinned
 * lookup. Build one per guarded request and destroy it when the request is done.
 */
export function createPinnedDispatcher(hostname: string, addresses: readonly ScreenedAddress[], tls: PinnedTlsOptions = {}): Agent {
  return new Agent({ connect: { ...tls, lookup: createPinnedLookup(hostname, addresses) } });
}

function lookupError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "ENOTFOUND";
  return error;
}
