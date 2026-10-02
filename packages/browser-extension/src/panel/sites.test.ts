import { describe, expect, it } from "vitest";
import { parseSiteInput, siteRows } from "./sites.js";
import { F } from "./test-frames.js";

describe("siteRows", () => {
  it("is every granted origin plus every origin the core names, each once, sorted, with the exact pattern", () => {
    const full = F.frame("frame.capabilities.full.json");
    if (full.type !== "capabilities") throw new Error("fixture");
    const rows = siteRows(["https://github.com/*", "https://docs.example.com/*"], full.origins);
    expect(rows).toEqual([
      { origin: "https://docs.example.com", host: "docs.example.com", pattern: "https://docs.example.com/*", granted: true, autoAcquire: true },
      { origin: "https://github.com", host: "github.com", pattern: "https://github.com/*", granted: true, autoAcquire: null },
      // An origin with a port is listed but can't be allowed: Scout refuses ports.
      { origin: "https://other.example.org:8443", host: "other.example.org:8443", pattern: null, granted: false, autoAcquire: false },
    ]);
  });

  it("a core origin Chrome does not grant is listed with Allow; broad grants are not rows", () => {
    expect(siteRows(["https://*/*", "<all_urls>"], [{ origin: "https://docs.stripe.com", autoAcquire: false, permitted: false }])).toEqual([
      { origin: "https://docs.stripe.com", host: "docs.stripe.com", pattern: "https://docs.stripe.com/*", granted: false, autoAcquire: false },
    ]);
  });
});

describe("parseSiteInput", () => {
  it.each([
    ["docs.stripe.com", "https://docs.stripe.com/*"],
    ["  Docs.Stripe.com ", "https://docs.stripe.com/*"],
    ["https://docs.stripe.com/api/charges?x=1", "https://docs.stripe.com/*"],
    ["github.com", "https://github.com/*"],
  ])("%s → %s", (text, pattern) => {
    expect(parseSiteInput(text)).toMatchObject({ ok: true, pattern });
  });

  it.each(["", "http://docs.stripe.com", "docs.stripe.com:8443", "user@docs.stripe.com", "127.0.0.1", "chrome://extensions", "not a host"])("refuses %j", (text) => {
    expect(parseSiteInput(text).ok).toBe(false);
  });
});
