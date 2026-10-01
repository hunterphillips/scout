import { isExactOriginPattern } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { checkSite, type SiteRefusal, sitePattern } from "./origin.js";

describe("checkSite (the popup's origin validation)", () => {
  const allowed: Array<[string, string]> = [
    ["https://github.com/acme/widgets/issues/1", "https://github.com/*"],
    ["https://docs.stripe.com/api?x=1#y", "https://docs.stripe.com/*"],
    ["https://WWW.PeakDesign.com/", "https://www.peakdesign.com/*"],
    ["https://example.com:443/a", "https://example.com/*"], // the default port is no port
    ["https://bücher.example/", "https://xn--bcher-kva.example/*"],
  ];
  for (const [url, pattern] of allowed) {
    it(`allows ${url} as ${pattern}`, () => {
      expect(checkSite(url, false)).toEqual({ ok: true, origin: pattern.slice(0, -2), pattern });
      // every pattern the popup can request is one the core accepts
      expect(isExactOriginPattern(pattern)).toBe(true);
    });
  }

  const refused: Array<[string | undefined, boolean, SiteRefusal]> = [
    ["https://github.com/", true, "incognito"],
    [undefined, false, "no-page"],
    ["", false, "no-page"],
    ["not a url", false, "no-page"],
    ["http://example.com/", false, "not-https"],
    ["chrome://extensions/", false, "internal"],
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html", false, "internal"],
    ["about:blank", false, "internal"],
    ["file:///Users/me/notes.txt", false, "internal"],
    ["edge://settings", false, "internal"],
    ["view-source:https://example.com/", false, "internal"],
    ["data:text/html,hi", false, "internal"],
    ["https://chromewebstore.google.com/detail/x", false, "internal"],
    ["https://chrome.google.com/webstore", false, "internal"],
    ["https://user:pw@example.com/", false, "credentials"],
    ["https://user@example.com/", false, "credentials"],
    ["https://example.com:8443/", false, "port"],
    ["https://192.168.1.10/", false, "host"],
    ["https://[::1]/", false, "host"],
    ["https://localhost./", false, "host"],
  ];
  for (const [url, incognito, reason] of refused) {
    it(`refuses ${String(url)}${incognito ? " (incognito)" : ""}: ${reason}`, () => {
      expect(checkSite(url, incognito)).toEqual({ ok: false, reason });
    });
  }

  it("sitePattern is the allowed pattern or null", () => {
    expect(sitePattern("https://github.com/a")).toBe("https://github.com/*");
    expect(sitePattern("http://github.com/a")).toBeNull();
  });
});
