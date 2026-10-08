// The job fixture on a real case: what loadCaseInputs reads is what the fixture core serves.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCaseInputs, makeThrowawayRoot, startJobFixture } from "./fixtures.mjs";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
});

const ORIGIN = "https://shop.example.net";

describe("startJobFixture with case inputs", () => {
  it("serves the file's site, links and pages, newest first", async () => {
    const t = makeThrowawayRoot("scout-fx-");
    roots.push(t);
    const candidatesFile = join(t.root, "catalog.json");
    writeFileSync(
      candidatesFile,
      JSON.stringify({ catalog: { origin: ORIGIN, version: "v-real", candidates: [{ id: "ca", sourceUrl: `${ORIGIN}/p/10`, title: "Flat burr grinder", description: "64 mm burrs", labelQuality: "published", provenance: "sitemap" }] } }),
    );
    const activityFile = join(t.root, "activity.json");
    writeFileSync(
      activityFile,
      JSON.stringify([
        { url: "https://news.example.org/a/grinders", title: "Burr grinders compared", text: "Flat and conical burrs." },
        { url: "https://forum.example.org/t/42", title: "Descaling" },
      ]),
    );
    const fixture = await startJobFixture(t.root, loadCaseInputs({ candidatesFile, activityFile }));
    try {
      let n = 0;
      const call = async (method, params = {}) => (await fixture.backend.call({ protocol: 1, requestId: `r${++n}`, method, params })).result;
      expect((await call("current_site")).site).toMatchObject({ origin: ORIGIN, url: `${ORIGIN}/` });
      expect(await call("site_links")).toMatchObject({ origin: ORIGIN, catalogVersion: "v-real", links: [{ id: "ca", href: `${ORIGIN}/p/10`, title: "Flat burr grinder", description: "64 mm burrs" }] });
      const { entries } = await call("recent_activity");
      expect(entries.map((e) => [e.origin, e.url, e.title, e.text])).toEqual([
        ["https://news.example.org", "https://news.example.org/a/grinders", "Burr grinders compared", "Flat and conical burrs."],
        ["https://forum.example.org", "https://forum.example.org/t/42", "Descaling", undefined],
      ]);
      expect(entries[0].observedAt).toBeGreaterThan(entries[1].observedAt);
    } finally {
      await fixture.close();
    }
  });
});
