// Ported from native/Scout/Tests/ScoutKitTests/LinkOpenerTests.swift: the same table of hrefs.
import { SOURCE_URL_MAX_CHARS } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { checkLink, LINK_REFUSALS, type LinkRefusal, refusalText, URL_MAX_BYTES } from "./links.js";

const ORIGIN = "https://docs.example.com";

describe("checkLink (LinkOpenerTests.swift)", () => {
  it.each([
    ["https://docs.example.com/webhooks", null],
    ["https://docs.example.com/guides/start?tab=a#top", null],
    ["https://docs.example.com/", null],
    ["http://docs.example.com/webhooks", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["data:text/html,hi", "not_https"],
    ["https://user:pw@docs.example.com/a", "credentials"],
    ["https://user@docs.example.com/a", "credentials"],
    ["https://docs.example.com:443/a", "port"],
    ["https://docs.example.com:8443/a", "port"],
    ["https://docs.example.com:/a", "port"],
    ["https://docs.example.com:", "port"],
    ["https://docs.example.com.:443/a", "port"],
    ["https://docs.example.com./a", "wrong_host"],
    ["https://docs.example.com.", "wrong_host"],
    ["https://other.example.com/a", "wrong_host"],
    ["https://docs.example.com.evil.example/a", "wrong_host"],
    ["https://evil.example/#docs.example.com", "wrong_host"],
    ["https://DOCS.EXAMPLE.COM/a", "wrong_host"],
    ["#top", "malformed"],
    ["/relative/path", "malformed"],
    ["", "malformed"],
    [" https://docs.example.com/a", "malformed"],
    ["https://docs.example.com/a b", "malformed"],
    ["https://docs.example.com\\@evil.example/", "malformed"],
    ["https://docs.example.com/é", "malformed"],
  ] as Array<[string, LinkRefusal | null]>)("%s → %s", (href, refusal) => {
    const r = checkLink(href, ORIGIN);
    if (refusal === null) expect(r).toEqual({ ok: true, url: href });
    else expect(r).toEqual({ ok: false, refusal });
  });

  it("aResultOnAnotherPortCannotOpen", () => {
    expect(checkLink("https://docs.example.com:8443/a", "https://docs.example.com:8443")).toEqual({ ok: false, refusal: "port" });
    expect(checkLink("https://docs.example.com/a", "https://docs.example.com:8443")).toEqual({ ok: false, refusal: "wrong_host" });
  });

  it("refusalsHaveText", () => {
    for (const r of LINK_REFUSALS) expect(refusalText(r)).not.toBe("");
  });

  it("the ack fixture's target passes for its origin; the URL limit is the contract's", () => {
    expect(checkLink("https://docs.example.com/webhooks", ORIGIN).ok).toBe(true);
    expect(URL_MAX_BYTES).toBe(SOURCE_URL_MAX_CHARS);
    expect(checkLink(`${ORIGIN}/${"a".repeat(URL_MAX_BYTES)}`, ORIGIN)).toEqual({ ok: false, refusal: "malformed" });
  });
});
