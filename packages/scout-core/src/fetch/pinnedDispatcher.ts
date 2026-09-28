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
 * hostname and fails the connection when there is nothing to pin.
 */
export function createPinnedLookup(hostname: string, addresses: readonly ScreenedAddress[]): ConnectLookup {
  const pinnedHost = hostname.toLowerCase();
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (requested, options, callback) => {
    if (requested.toLowerCase() !== pinnedHost) {
      callback(lookupError(`No pinned addresses for ${requested}`), []);
      return;
    }
    const first = pinned[0];
    if (!first) {
      callback(lookupError(`No pinned addresses for ${requested}`), []);
      return;
    }
    if (options.all) callback(null, pinned);
    else callback(null, first.address, first.family);
  };
}

/**
 * An undici dispatcher whose connections resolve `hostname` only through the pinned
 * lookup. Build one per guarded request and destroy it when the request is done.
 */
export function createPinnedDispatcher(hostname: string, addresses: readonly ScreenedAddress[]): Agent {
  return new Agent({ connect: { lookup: createPinnedLookup(hostname, addresses) } });
}

function lookupError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "ENOTFOUND";
  return error;
}
