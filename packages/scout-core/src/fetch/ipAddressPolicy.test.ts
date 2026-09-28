// Adapted from rookkeeper/rook server/src/infrastructure/http/ipAddressPolicy.test.ts (Rook, by
// John Berryman / Arcturus Labs). Scout changes: rows for the ranges Scout adds.

import { describe, expect, it } from "vitest";
import { isDisallowedAddress } from "./ipAddressPolicy.js";

describe("isDisallowedAddress", () => {
  it("classifies loopback, unspecified, private, link-local, and IPv4-mapped addresses", () => {
    const disallowed = [
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1",
      "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1", "::ffff:7f00:1",
      "not-an-address",
    ];
    const allowed = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "2606:2800:220:1::1", "::ffff:93.184.216.34"];

    expect(disallowed.filter((address) => !isDisallowedAddress(address))).toEqual([]);
    expect(allowed.filter((address) => isDisallowedAddress(address))).toEqual([]);
  });

  it.each([
    ["100.64.0.1", "CGNAT low edge"],
    ["100.100.100.100", "CGNAT (Tailscale)"],
    ["100.127.255.255", "CGNAT high edge"],
    ["224.0.0.1", "multicast low edge"],
    ["239.255.255.250", "multicast high edge"],
    ["255.255.255.255", "limited broadcast"],
    ["198.18.0.1", "benchmarking low half"],
    ["198.19.255.255", "benchmarking high half"],
    ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
    ["64:ff9b::10.0.0.1", "NAT64 of 10.0.0.1"],
    ["2002:7f00:1::", "6to4 of 127.0.0.1"],
    ["2002:c0a8:101::1", "6to4 of 192.168.1.1"],
    ["::7f00:1", "IPv4-compatible 127.0.0.1"],
    ["::10.0.0.1", "IPv4-compatible 10.0.0.1"],
    ["ff02::1", "multicast"],
    ["ff05::2", "multicast, site scope"],
    ["fec0::1", "site-local"],
    ["feff::1", "site-local high edge"],
  ])("refuses %s (%s)", (address) => {
    expect(isDisallowedAddress(address)).toBe(true);
  });

  it.each([
    ["100.63.255.255", "just below CGNAT"],
    ["100.128.0.1", "just above CGNAT"],
    ["198.17.255.255", "just below benchmarking"],
    ["198.20.0.1", "just above benchmarking"],
    ["223.255.255.255", "just below multicast"],
    ["64:ff9b::5db8:d822", "NAT64 of 93.184.216.34"],
    ["2002:5db8:d822::1", "6to4 of 93.184.216.34"],
    ["::93.184.216.34", "IPv4-compatible public address"],
    ["fe00::1", "just below link-local"],
  ])("allows %s (%s)", (address) => {
    expect(isDisallowedAddress(address)).toBe(false);
  });
});
