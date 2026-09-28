// Adapted from rookkeeper/rook server/src/infrastructure/http/ipAddressPolicy.ts (Rook, by John
// Berryman / Arcturus Labs). Scout changes: also refuses IPv4 100.64.0.0/10 (CGNAT),
// 198.18.0.0/15, 224.0.0.0/4 multicast, and 255.255.255.255; IPv6 ff00::/8 multicast and
// fec0::/10 site-local; and applies the IPv4 rules to the address embedded in NAT64
// (64:ff9b::/96), 6to4 (2002::/16), and IPv4-compatible (::a.b.c.d) forms.

/**
 * IP literal classification for outbound request policy.
 *
 * The only question this module answers: may a request be made to this address?
 * Loopback, unspecified, private, link-local, CGNAT, benchmarking, multicast, broadcast,
 * and site-local ranges are refused, as are IPv6 forms that embed a refused IPv4 address
 * (mapped, IPv4-compatible, NAT64, 6to4). Anything unparseable fails closed.
 */

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** Expand an IPv6 literal (including the `::ffff:1.2.3.4` form) into eight 16-bit groups. */
function parseIpv6(address: string): number[] | null {
  const bare = address.split("%")[0]!.toLowerCase();
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const expand = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const octets = parseIpv4(part);
        if (!octets) return null;
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function isDisallowedIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // unspecified / "this network"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale, carrier NAT)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (octets.every((octet) => octet === 255)) return true; // limited broadcast
  return false;
}

/** The IPv4 address carried in two 16-bit groups, as four octets. */
function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * True when an IP literal is in a refused range (see the module comment) or is an IPv6
 * form embedding a refused IPv4 address. Unparseable input fails closed.
 */
export function isDisallowedAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isDisallowedIpv4(ipv4);

  const groups = parseIpv6(address);
  if (!groups) return true;

  const zeroThrough = (end: number) => groups.slice(0, end).every((group) => group === 0);
  const isMapped = zeroThrough(5) && groups[5] === 0xffff;
  if (isMapped) return isDisallowedIpv4(embeddedIpv4(groups[6]!, groups[7]!));
  if (groups.every((group) => group === 0)) return true; // ::
  if (zeroThrough(7) && groups[7] === 1) return true; // ::1
  // IPv4-compatible ::a.b.c.d (first 96 bits zero): judge the embedded IPv4 address.
  if (zeroThrough(6)) return isDisallowedIpv4(embeddedIpv4(groups[6]!, groups[7]!));
  // NAT64 64:ff9b::/96: the last 32 bits are the IPv4 destination.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isDisallowedIpv4(embeddedIpv4(groups[6]!, groups[7]!));
  }
  // 6to4 2002::/16: groups 1-2 are the IPv4 relay address.
  if (groups[0] === 0x2002) return isDisallowedIpv4(embeddedIpv4(groups[1]!, groups[2]!));
  if ((groups[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}
