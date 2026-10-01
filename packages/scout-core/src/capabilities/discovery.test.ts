import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPacedCatalogFetch } from "../catalog/pacing.js";
import { createCatalogResolver } from "../catalog/resolveCatalog.js";
import type { DiagnosticFields, Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { createOriginFetchSession } from "../fetch/originSession.js";
import { createSiteResourceDiscoverer, discoverSiteResources, type DiscoveryResult, type ProbeItem } from "./discovery.js";
import { createDiscoveryCache } from "./discoveryCache.js";
import { DISCOVERY_SCHEMA_PREFIX } from "./skillsIndex.js";

const ORIGIN = "https://s.example";
const HOUR = 60 * 60 * 1000;
const INDEX_PATH = "/.well-known/agent-skills/index.json";
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(enc(s)).digest("hex");

const LLMS = "# Site\n\n- [Docs](/docs): the docs\n";
const AGENTS = "# Agents\n\nUse the API.\n";
const SKILL = "---\nname: checkout\ndescription: Pay\n---\n# Checkout\nSteps.\n";

type Response = string | { body?: string | Uint8Array; status?: number; contentType?: string; finalPath?: string; error?: GuardedFetchResult & { kind: "error" } };

/** A fake site behind `guardedFetch`: per-path responses, ETags from the body hash, 304 on a matching If-None-Match. */
function fakeSite(initial: Record<string, Response>) {
  const site: Record<string, Response> = { ...initial };
  const requests: { path: string; url: string; options: GuardedFetchOptions }[] = [];
  const guardedFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    const path = new URL(url).pathname;
    requests.push({ path, url, options });
    const spec = site[path];
    if (spec === undefined) return { kind: "absent", status: 404 };
    const r = typeof spec === "string" ? { body: spec } : spec;
    if (r.error) return r.error;
    if (r.status !== undefined && r.status !== 200) return r.status === 404 ? { kind: "absent", status: 404 } : { kind: "error", reason: "http", status: r.status, message: "http" };
    const bytes = typeof r.body === "string" ? enc(r.body) : (r.body ?? new Uint8Array());
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) return { kind: "error", reason: "too_large", message: "too large" };
    const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}"`;
    if (options.ifNoneMatch === etag) return { kind: "not_modified", etag };
    const finalUrl = r.finalPath ? new URL(r.finalPath, url).href : url;
    return { kind: "ok", status: 200, body: new TextDecoder().decode(bytes), bytes, etag, finalUrl, ...(r.contentType ? { contentType: r.contentType } : {}) };
  };
  const paths = () => requests.map((r) => r.path);
  return { site, guardedFetch, requests, paths };
}

const indexOf = (skills: unknown[], extra: object = {}) => JSON.stringify({ $schema: `${DISCOVERY_SCHEMA_PREFIX}v1.json`, skills, ...extra });
const skillEntry = (name: string, body: string, over: object = {}) => ({ name, type: "skill-md", description: `${name} skill`, url: `/skills/${name}/SKILL.md`, digest: `sha256:${sha(body)}`, ...over });

let home: string;
let now: number;
let events: { name: string; fields: DiagnosticFields }[];
const clock = { now: () => now };
const diagnostics: Diagnostics = { event: (name, fields = {}) => void events.push({ name, fields }), failures: 0 };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-discovery-"));
  now = 1_800_000_000_000;
  events = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function discoverer(guardedFetch: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>) {
  return createSiteResourceDiscoverer({ scoutHome: home, clock, diagnostics, guardedFetch, sleep: async () => undefined });
}

const byKind = (result: DiscoveryResult, kind: ProbeItem["kind"]) => result.items.filter((i) => i.kind === kind);
const one = (result: DiscoveryResult, kind: ProbeItem["kind"]) => byKind(result, kind)[0] as ProbeItem;
const skillNamed = (result: DiscoveryResult, name: string) => result.items.find((i) => i.kind === "skill" && i.entry?.name === name) as ProbeItem;

describe("discoverSiteResources", () => {
  it("acquires the root guides and a digest-verified skill with the fields a version needs", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": { body: AGENTS, contentType: "text/markdown" }, [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": SKILL });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);

    expect(one(result, "llms_txt")).toMatchObject({ status: "found", source: "network", resource: { kind: "llms_txt", text: LLMS, sha256: sha(LLMS), byteLength: enc(LLMS).byteLength } });
    expect(one(result, "agents_md").resource).toMatchObject({ kind: "agents_md", siteOrigin: ORIGIN, publisherOrigin: ORIGIN, sourceUrl: `${ORIGIN}/AGENTS.md`, finalUrl: `${ORIGIN}/AGENTS.md`, contentType: "text/markdown", fetchedAt: now });
    expect(one(result, "agents_md").resource?.etag).toBeDefined();
    expect(one(result, "skills_index")).toMatchObject({ status: "found" });
    expect(skillNamed(result, "checkout")).toMatchObject({
      status: "found",
      sourceUrl: `${ORIGIN}/skills/checkout/SKILL.md`,
      resource: { kind: "skill", text: SKILL, skill: { name: "checkout", description: "checkout skill", sha256: sha(SKILL) } },
    });
    expect(result.acceptedBytes).toBe(enc(LLMS).byteLength + enc(AGENTS).byteLength + enc(SKILL).byteLength);
    expect(site.paths()).toEqual(["/robots.txt", "/llms.txt", "/AGENTS.md", INDEX_PATH, "/skills/checkout/SKILL.md"]);
  });

  it("rejects a skill whose body does not match the published digest", async () => {
    const site = fakeSite({ [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": `${SKILL}tampered\n` });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    const skill = skillNamed(result, "checkout");
    expect(skill).toMatchObject({ status: "failed", code: "digest_mismatch" });
    expect(skill.resource).toBeUndefined();
    expect(result.acceptedBytes).toBe(0);
  });

  it("keeps absent, failed, unsupported, and limited apart", async () => {
    const site = fakeSite({
      "/AGENTS.md": { error: { kind: "error", reason: "timeout", message: "t" } },
      [INDEX_PATH]: indexOf([skillEntry("bundle", "x", { type: "archive", url: "/skills/bundle.zip" }), skillEntry("big", "y".repeat(70 * 1024))]),
      "/skills/big/SKILL.md": "y".repeat(70 * 1024),
    });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(result, "llms_txt")).toMatchObject({ status: "absent" });
    expect(one(result, "agents_md")).toMatchObject({ status: "failed", code: "timeout" });
    expect(skillNamed(result, "bundle")).toMatchObject({ status: "unsupported", code: "archive" });
    expect(skillNamed(result, "big")).toMatchObject({ status: "limited", code: "too_large" });
  });

  it("never downloads more than its own 128 KiB cap for llms.txt", async () => {
    const site = fakeSite({ "/llms.txt": `# Big\n${"x".repeat(300 * 1024)}` });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(result, "llms_txt")).toMatchObject({ status: "limited", code: "too_large" });
    expect(site.requests.find((r) => r.path === "/llms.txt")?.options.maxBytes).toBe(128 * 1024);
  });

  it("rejects an HTML fallback page served as text/markdown and invalid encodings", async () => {
    const site = fakeSite({
      "/llms.txt": { body: "<!doctype html><html><div id=root></div></html>", contentType: "text/markdown" },
      "/AGENTS.md": { body: new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]), contentType: "text/markdown" },
    });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(result, "llms_txt")).toMatchObject({ status: "unsupported", code: "html" });
    expect(one(result, "agents_md")).toMatchObject({ status: "unsupported", code: "invalid_utf8" });
    expect(result.acceptedBytes).toBe(0);
  });

  it("never requests advertised MCP endpoints, archives, or cross-origin skills", async () => {
    const site = fakeSite({
      "/llms.txt": "# Site\n\n- [MCP server](https://s.example/mcp): connect here\n",
      [INDEX_PATH]: indexOf(
        [
          skillEntry("remote", SKILL, { url: "https://cdn.other.example/remote/SKILL.md" }),
          skillEntry("bundle", "x", { type: "archive", url: "/skills/bundle.zip" }),
          skillEntry("tool", "x", { url: "/skills/tool/run.sh" }),
        ],
        { mcpServers: [{ name: "shop", url: "https://s.example/mcp" }, { url: "https://mcp.other.example/sse" }] },
      ),
    });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(site.paths()).toEqual(["/robots.txt", "/llms.txt", "/AGENTS.md", INDEX_PATH]);
    expect(site.requests.every((r) => r.url.startsWith(`${ORIGIN}/`))).toBe(true);
    expect(result.externalReferences).toEqual([
      { position: 0, name: "remote", description: "remote skill", url: "https://cdn.other.example/remote/SKILL.md", publisherOrigin: "https://cdn.other.example" },
    ]);
    expect(byKind(result, "skill").map((i) => i.code)).toEqual(["archive", "file_type"]);
  });

  it("honors robots.txt for resource probes", async () => {
    const site = fakeSite({ "/robots.txt": "User-agent: *\nDisallow: /AGENTS.md\nDisallow: /skills/\n", "/AGENTS.md": AGENTS, [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": SKILL });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(result, "agents_md")).toMatchObject({ status: "failed", code: "robots_disallowed" });
    expect(skillNamed(result, "checkout")).toMatchObject({ status: "failed", code: "robots_disallowed" });
    expect(site.paths()).not.toContain("/AGENTS.md");
    expect(site.paths()).not.toContain("/skills/checkout/SKILL.md");
  });

  it("counts index entries past the cap as limited, not absent", async () => {
    const skills = Array.from({ length: 22 }, (_, i) => skillEntry(`s${i}`, "x", { type: "archive", url: `/s${i}.zip` }));
    const site = fakeSite({ [INDEX_PATH]: indexOf(skills) });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(result.skillsOverCap).toBe(2);
    expect(byKind(result, "skill")).toHaveLength(20);
  });

  it("marks resources over the per-pass byte budget as limited and leaves them for the next pass", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": AGENTS });
    const cache = createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") });
    const fetch = createPacedCatalogFetch({ origin: ORIGIN, clock, guardedFetch: site.guardedFetch });
    const result = await discoverSiteResources(ORIGIN, { fetch, clock, cache, maxAcceptedBytes: enc(LLMS).byteLength + 1 });
    expect(one(result, "llms_txt").status).toBe("found");
    expect(one(result, "agents_md")).toMatchObject({ status: "limited", code: "pass_budget" });
    expect(cache.load(ORIGIN)?.probes.map((p) => p.url)).not.toContain(`${ORIGIN}/AGENTS.md`);
  });

  it("does not record a pacing refusal as the site's answer", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": AGENTS });
    const cache = createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") });
    const fetch = createPacedCatalogFetch({ origin: ORIGIN, clock, guardedFetch: site.guardedFetch, maxRequests: 2 });
    const result = await discoverSiteResources(ORIGIN, { fetch, clock, cache });
    expect(one(result, "agents_md")).toMatchObject({ status: "limited", code: "refused", source: "none" });
    expect(result.stats.refused).toBeGreaterThan(0);
    expect(cache.load(ORIGIN)?.probes.map((p) => p.url)).toEqual([`${ORIGIN}/llms.txt`]);
    // The next pass asks again rather than trusting a partial result.
    const again = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(again, "agents_md").status).toBe("found");
    expect(one(again, "llms_txt").source).toBe("cache");
  });

  it("lets a scout robots group override the * group for a skill path", async () => {
    const skills = { [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": SKILL };
    const allowedForScout = fakeSite({ "/robots.txt": "User-agent: *\nDisallow: /skills/\n\nUser-agent: scout\nDisallow: /private/\n", ...skills });
    expect(skillNamed(await discoverer(allowedForScout.guardedFetch).discover(ORIGIN), "checkout")).toMatchObject({ status: "found" });

    rmSync(join(home, "cache"), { recursive: true, force: true });
    const blockedForScout = fakeSite({ "/robots.txt": "User-agent: *\nAllow: /\n\nUser-agent: scout\nDisallow: /skills/checkout/\n", ...skills });
    const result = await discoverer(blockedForScout.guardedFetch).discover(ORIGIN);
    expect(skillNamed(result, "checkout")).toMatchObject({ status: "failed", code: "robots_disallowed" });
    expect(blockedForScout.paths()).not.toContain("/skills/checkout/SKILL.md");
  });

  it("refuses only the skill robots disallows and still reads the index and root files", async () => {
    const site = fakeSite({
      "/robots.txt": "User-agent: *\nDisallow: /skills/secret/SKILL.md\n",
      "/llms.txt": LLMS,
      [INDEX_PATH]: indexOf([skillEntry("secret", SKILL, { url: "/skills/secret/SKILL.md" }), skillEntry("checkout", SKILL)]),
      "/skills/checkout/SKILL.md": SKILL,
    });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(one(result, "llms_txt").status).toBe("found");
    expect(one(result, "skills_index").status).toBe("found");
    expect(skillNamed(result, "secret")).toMatchObject({ status: "failed", code: "robots_disallowed", source: "none" });
    expect(skillNamed(result, "checkout").status).toBe("found");
    expect(site.paths()).not.toContain("/skills/secret/SKILL.md");
  });

  it("resolves relative index entries against the index's final URL after a same-host redirect", async () => {
    const site = fakeSite({
      [INDEX_PATH]: { body: indexOf([skillEntry("checkout", SKILL, { url: "checkout/SKILL.md" })]), finalPath: "/agent/v2/index.json" },
      "/agent/v2/checkout/SKILL.md": SKILL,
    });
    const result = await discoverer(site.guardedFetch).discover(ORIGIN);
    expect(skillNamed(result, "checkout")).toMatchObject({ status: "found", sourceUrl: `${ORIGIN}/agent/v2/checkout/SKILL.md`, resource: { text: SKILL } });
    expect(site.paths()).toContain("/agent/v2/checkout/SKILL.md");
  });

  describe("cache", () => {
    const fullSite = () => fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": AGENTS, [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": SKILL });

    it("serves a fresh pass with no requests, then revalidates conditionally after 24 h", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      site.requests.length = 0;

      now += 23 * HOUR;
      const fresh = await d.discover(ORIGIN);
      expect(site.requests).toHaveLength(0);
      expect(fresh.items.every((i) => i.source === "cache")).toBe(true);
      expect(skillNamed(fresh, "checkout").resource?.text).toBe(SKILL);

      now += 2 * HOUR;
      const revalidated = await d.discover(ORIGIN);
      expect(site.requests.filter((r) => r.path !== "/robots.txt").every((r) => r.options.ifNoneMatch !== undefined)).toBe(true);
      expect(revalidated.items.map((i) => i.source)).toEqual(["not_modified", "not_modified", "not_modified", "not_modified"]);
      expect(one(revalidated, "llms_txt").resource?.text).toBe(LLMS);
      expect(events.filter((e) => e.name === "resource_cache").map((e) => e.fields.source)).toEqual(["miss", "fresh", "revalidated"]);
    });

    it("keeps the other results and the last good text when one probe fails", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      now += 25 * HOUR;
      site.site["/AGENTS.md"] = { status: 503 };
      const result = await d.discover(ORIGIN);
      expect(one(result, "agents_md")).toMatchObject({ status: "failed", code: "http_5xx", resource: { text: AGENTS } });
      expect(one(result, "llms_txt").status).toBe("found");
      expect(skillNamed(result, "checkout").status).toBe("found");
      const stored = createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") }).load(ORIGIN);
      expect(stored?.probes.find((p) => p.kind === "agents_md")).toMatchObject({ status: "failed", stored: { text: AGENTS } });
    });

    it("shows cached skills without fetching them when the index fails", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      now += 25 * HOUR;
      site.site[INDEX_PATH] = { error: { kind: "error", reason: "network", message: "reset" } };
      site.requests.length = 0;
      const result = await d.discover(ORIGIN);
      expect(one(result, "skills_index")).toMatchObject({ status: "failed", code: "network" });
      expect(skillNamed(result, "checkout")).toMatchObject({ status: "found", source: "cache", resource: { text: SKILL } });
      expect(site.paths()).not.toContain("/skills/checkout/SKILL.md");
    });

    it("backs off a failed probe 15 min, 1 h, then 6 h, and refresh skips the wait", async () => {
      const site = fakeSite({ "/llms.txt": { error: { kind: "error", reason: "network", message: "down" } } });
      const d = discoverer(site.guardedFetch);
      const llmsRequests = () => site.paths().filter((p) => p === "/llms.txt").length;

      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(1);
      now += 14 * 60 * 1000;
      expect(one(await d.discover(ORIGIN), "llms_txt")).toMatchObject({ status: "failed", source: "cache" });
      expect(llmsRequests()).toBe(1);
      now += 2 * 60 * 1000;
      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(2);
      now += 59 * 60 * 1000;
      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(2);
      now += 2 * 60 * 1000;
      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(3);
      now += 5 * HOUR;
      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(3);
      await d.discover(ORIGIN, { refresh: true });
      expect(llmsRequests()).toBe(4);
    });

    it("resets the backoff after a success", async () => {
      const site = fakeSite({ "/llms.txt": { error: { kind: "error", reason: "network", message: "down" } } });
      const d = discoverer(site.guardedFetch);
      const llmsRequests = () => site.paths().filter((p) => p === "/llms.txt").length;
      const llmsRecord = () => createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") }).load(ORIGIN)?.probes.find((p) => p.kind === "llms_txt");

      await d.discover(ORIGIN);
      now += 16 * 60 * 1000;
      await d.discover(ORIGIN);
      expect(llmsRecord()).toMatchObject({ status: "failed", failures: 2 });

      site.site["/llms.txt"] = LLMS;
      now += 61 * 60 * 1000;
      expect(one(await d.discover(ORIGIN), "llms_txt").status).toBe("found");
      expect(llmsRecord()).toMatchObject({ status: "found", failures: 0 });

      // The next failure starts over at the 15-minute step, not the 6-hour one.
      site.site["/llms.txt"] = { error: { kind: "error", reason: "network", message: "down" } };
      now += 25 * HOUR;
      expect(one(await d.discover(ORIGIN), "llms_txt")).toMatchObject({ status: "failed", resource: { text: LLMS } });
      expect(llmsRecord()).toMatchObject({ failures: 1 });
      const before = llmsRequests();
      now += 16 * 60 * 1000;
      await d.discover(ORIGIN);
      expect(llmsRequests()).toBe(before + 1);
    });

    it("replaces stored validators with the ones a 304 carries", async () => {
      const site = fullSite();
      let notModifiedWith: { etag?: string; lastModified?: string } | null = null;
      const seen: GuardedFetchOptions[] = [];
      const guardedFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
        if (new URL(url).pathname === "/llms.txt") seen.push(options);
        if (notModifiedWith && new URL(url).pathname === "/llms.txt") return { kind: "not_modified", ...notModifiedWith };
        return site.guardedFetch(url, options);
      };
      const d = discoverer(guardedFetch);
      await d.discover(ORIGIN);

      notModifiedWith = { etag: '"rotated"', lastModified: "Tue, 02 Sep 2026 00:00:00 GMT" };
      now += 25 * HOUR;
      expect(one(await d.discover(ORIGIN), "llms_txt")).toMatchObject({ status: "found", source: "not_modified", resource: { text: LLMS, etag: '"rotated"', lastModified: "Tue, 02 Sep 2026 00:00:00 GMT" } });
      const stored = createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") }).load(ORIGIN)?.probes.find((p) => p.kind === "llms_txt")?.stored;
      expect(stored).toMatchObject({ etag: '"rotated"', lastModified: "Tue, 02 Sep 2026 00:00:00 GMT" });

      now += 25 * HOUR;
      await d.discover(ORIGIN);
      expect(seen.at(-1)).toMatchObject({ ifNoneMatch: '"rotated"', ifModifiedSince: "Tue, 02 Sep 2026 00:00:00 GMT" });
    });

    it("keeps the verified skill when the site serves a body that no longer matches the unchanged digest", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      site.site["/skills/checkout/SKILL.md"] = `${SKILL}tampered\n`;
      now += 25 * HOUR;
      const result = await d.discover(ORIGIN, { refresh: true });
      expect(skillNamed(result, "checkout")).toMatchObject({ status: "failed", code: "digest_mismatch", resource: { text: SKILL, sha256: sha(SKILL) } });
      const stored = createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") }).load(ORIGIN)?.probes.find((p) => p.kind === "skill");
      expect(stored).toMatchObject({ status: "failed", code: "digest_mismatch", stored: { text: SKILL } });
    });

    it("drops the last good text once it is older than the 7-day stale limit", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      const started = now;
      await d.discover(ORIGIN);
      site.site["/AGENTS.md"] = { status: 503 };
      const load = () => createDiscoveryCache({ clock, dir: join(home, "cache", "discovery") }).load(ORIGIN)?.probes.find((p) => p.kind === "agents_md");

      // Inside the limit: a failure keeps the text.
      now = started + 7 * 24 * HOUR - 10 * 60 * 1000;
      expect(one(await d.discover(ORIGIN), "agents_md")).toMatchObject({ status: "failed", resource: { text: AGENTS } });

      // Past it, still inside the 15-minute backoff: the cached failure no longer carries the text.
      now = started + 7 * 24 * HOUR + 60 * 1000;
      const cachedFailure = one(await d.discover(ORIGIN), "agents_md");
      expect(cachedFailure).toMatchObject({ status: "failed", code: "http_5xx", source: "cache" });
      expect(cachedFailure.resource).toBeUndefined();
      expect(load()?.stored).toBeUndefined();

      // A fresh failure past the limit is a plain failure too.
      now += 2 * HOUR;
      const fresh = one(await d.discover(ORIGIN), "agents_md");
      expect(fresh).toMatchObject({ status: "failed", code: "http_5xx", source: "network" });
      expect(fresh.resource).toBeUndefined();
    });

    it("refresh still sends validators and keeps the text on a 304", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      site.requests.length = 0;
      const result = await d.discover(ORIGIN, { refresh: true });
      expect(site.requests.find((r) => r.path === "/llms.txt")?.options.ifNoneMatch).toBeDefined();
      expect(one(result, "llms_txt")).toMatchObject({ status: "found", source: "not_modified", resource: { text: LLMS } });
    });

    it("refetches a skill when the index publishes a new digest", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      const updated = `${SKILL}More steps.\n`;
      site.site[INDEX_PATH] = indexOf([skillEntry("checkout", updated)]);
      site.site["/skills/checkout/SKILL.md"] = updated;
      now += 25 * HOUR;
      site.requests.length = 0;
      const result = await d.discover(ORIGIN);
      expect(skillNamed(result, "checkout")).toMatchObject({ status: "found", source: "network", resource: { text: updated } });
      expect(site.requests.find((r) => r.path === "/skills/checkout/SKILL.md")?.options.ifNoneMatch).toBeUndefined();
    });

    it("treats a corrupt cache file as invalid, rediscovers, and writes private files", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      const dir = join(home, "cache", "discovery");
      const [file] = readdirSync(dir);
      const path = join(dir, file as string);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      writeFileSync(path, readFileSync(path, "utf8").replace("Use the API.", "Use the APX."));
      site.requests.length = 0;
      const result = await d.discover(ORIGIN);
      expect(events.find((e) => e.name === "resource_cache_invalid")?.fields).toMatchObject({ origin: ORIGIN, code: "hash" });
      expect(one(result, "agents_md")).toMatchObject({ status: "found", source: "network", resource: { text: AGENTS } });

      writeFileSync(path, "{not json");
      const again = await d.discover(ORIGIN);
      expect(events.filter((e) => e.name === "resource_cache_invalid").map((e) => e.fields.code)).toEqual(["hash", "parse"]);
      expect(one(again, "llms_txt").status).toBe("found");
    });

    it("refuses an oversized file unread, and records with a foreign final URL, a repeated URL, or an unknown code", async () => {
      const site = fullSite();
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      const dir = join(home, "cache", "discovery");
      const path = join(dir, readdirSync(dir)[0] as string);
      const good = readFileSync(path, "utf8");
      const cache = createDiscoveryCache({ clock, dir, diagnostics });
      const codes = () => events.filter((e) => e.name === "resource_cache_invalid").map((e) => e.fields.code);

      writeFileSync(path, " ".repeat(4 * 1024 * 1024 + 1));
      expect(cache.load(ORIGIN)).toBeNull();

      type File = { probes: { url: string; code?: string; stored?: { finalUrl: string } }[] };
      const edit = (change: (f: File) => void) => {
        const copy = JSON.parse(good) as File;
        change(copy);
        writeFileSync(path, JSON.stringify(copy));
        return cache.load(ORIGIN);
      };
      expect(edit((f) => void ((f.probes[0] as { stored: { finalUrl: string } }).stored.finalUrl = "https://evil.example/llms.txt"))).toBeNull();
      expect(edit((f) => void f.probes.push({ ...(f.probes[0] as File["probes"][number]) }))).toBeNull();
      expect(edit((f) => void ((f.probes[0] as { code?: string }).code = "made_up"))).toBeNull();
      expect(codes()).toEqual(["file_too_large", "final_url", "duplicate_url", "parse"]);
    });

    it("reports a pass that only re-reads the cache as fresh even with unprobed index entries", async () => {
      const site = fakeSite({ "/llms.txt": LLMS, [INDEX_PATH]: indexOf([skillEntry("bundle", "x", { type: "archive", url: "/skills/bundle.zip" })]) });
      const d = discoverer(site.guardedFetch);
      await d.discover(ORIGIN);
      now += HOUR;
      const result = await d.discover(ORIGIN);
      expect(skillNamed(result, "bundle")).toMatchObject({ status: "unsupported", source: "none" });
      expect(events.filter((e) => e.name === "resource_cache").map((e) => e.fields.source)).toEqual(["miss", "fresh"]);
    });
  });

  it("emits scalar diagnostics with origin-only locations", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, [INDEX_PATH]: indexOf([skillEntry("checkout", SKILL)]), "/skills/checkout/SKILL.md": SKILL });
    await discoverer(site.guardedFetch).discover(ORIGIN);
    const discover = events.find((e) => e.name === "resource_discover")?.fields;
    expect(discover).toMatchObject({ origin: ORIGIN, found: 3, absent: 1, requests: 5, llmsTxt: "found", agentsMd: "absent", skillsIndex: "found" });
    for (const event of events) {
      for (const [key, value] of Object.entries(event.fields)) {
        if (key !== "origin") expect(String(value)).not.toContain("://");
      }
    }
  });
});

describe("shared origin fetch session", () => {
  it("serves catalog resolution and discovery from one request per shared root file", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": AGENTS, "/sitemap.xml": "<urlset><url><loc>https://s.example/a</loc></url></urlset>" });
    const session = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch: site.guardedFetch, sleep: async () => undefined });
    session.startWindow();
    const catalog = createCatalogResolver({ scoutHome: home, clock, guardedFetch: site.guardedFetch, sleep: async () => undefined });
    const resources = discoverer(site.guardedFetch);

    const [resolved, discovered] = await Promise.all([catalog.resolve(ORIGIN, { session }), resources.discover(ORIGIN, { session })]);

    expect(resolved.result.ok && resolved.result.catalog.candidates.length).toBeGreaterThan(0);
    expect(one(discovered, "llms_txt")).toMatchObject({ status: "found", resource: { text: LLMS } });
    expect(site.paths().filter((p) => p === "/llms.txt")).toHaveLength(1);
    expect(site.paths().filter((p) => p === "/robots.txt")).toHaveLength(1);
    expect(session.stats().requests).toBe(site.requests.length);
  });

  it("on a warm pass sends the shared conditional llms.txt request once, and keeps both caches' validators in step", async () => {
    // ETags rotate on every 304, so the caches only coalesce if both store what the 304 carried.
    const bodies: Record<string, string> = {
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/llms.txt": LLMS,
      "/AGENTS.md": AGENTS,
      "/sitemap.xml": "<urlset><url><loc>https://s.example/a</loc></url></urlset>",
    };
    const version: Record<string, number> = {};
    const requests: { path: string; options: GuardedFetchOptions }[] = [];
    const lastModified = "Mon, 01 Sep 2026 00:00:00 GMT";
    const guardedFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
      const path = new URL(url).pathname;
      requests.push({ path, options });
      const body = bodies[path];
      if (body === undefined) return { kind: "absent", status: 404 };
      const etag = `"${path}#${version[path] ?? 0}"`;
      if (options.ifNoneMatch === etag) {
        version[path] = (version[path] ?? 0) + 1;
        return { kind: "not_modified", etag: `"${path}#${version[path]}"` };
      }
      const bytes = enc(body);
      return { kind: "ok", status: 200, body, bytes, etag, lastModified, finalUrl: url };
    };
    const sleep = async () => undefined;
    const catalog = createCatalogResolver({ scoutHome: home, clock, guardedFetch, sleep });
    const resources = createSiteResourceDiscoverer({ scoutHome: home, clock, diagnostics, guardedFetch, sleep });
    const pass = async () => {
      const session = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch, sleep });
      session.startWindow();
      requests.length = 0;
      const [resolved, discovered] = await Promise.all([catalog.resolve(ORIGIN, { session }), resources.discover(ORIGIN, { session })]);
      return { resolved, discovered, session };
    };
    const count = (path: string) => requests.filter((r) => r.path === path).length;

    await pass(); // cold: primes both caches

    for (let warm = 1; warm <= 2; warm++) {
      now += 25 * HOUR;
      const { resolved, discovered, session } = await pass();
      expect(resolved.result).toMatchObject({ ok: true, source: "not_modified" });
      expect(one(discovered, "llms_txt")).toMatchObject({ status: "found", source: "not_modified", resource: { text: LLMS } });
      expect(count("/llms.txt")).toBe(1);
      expect(requests.find((r) => r.path === "/llms.txt")?.options).toMatchObject({ ifNoneMatch: `"/llms.txt#${warm - 1}"`, ifModifiedSince: lastModified });
      expect(count("/AGENTS.md")).toBe(1);
      expect(count("/sitemap.xml")).toBe(1);
      // robots.txt is the one shared file that goes out twice: the catalog revalidates it
      // conditionally, while discovery needs the rules and asks without validators.
      expect(requests.filter((r) => r.path === "/robots.txt").map((r) => r.options.ifNoneMatch === undefined).sort()).toEqual([false, true]);
      expect(session.stats().requests).toBe(requests.length);
    }
  });

  it("leaves the pacing window to the session's owner", async () => {
    const site = fakeSite({ "/llms.txt": LLMS, "/AGENTS.md": AGENTS, "/sitemap.xml": "<urlset><url><loc>https://s.example/a</loc></url></urlset>" });
    const catalog = createCatalogResolver({ scoutHome: home, clock, guardedFetch: site.guardedFetch, sleep: async () => undefined });
    const resources = discoverer(site.guardedFetch);
    let windows = 0;
    const run = async () => {
      const inner = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch: site.guardedFetch, sleep: async () => undefined });
      const session = { ...inner, startWindow: () => void (windows += 1, inner.startWindow()) };
      await Promise.all([catalog.resolve(ORIGIN, { session }), resources.discover(ORIGIN, { session })]);
      expect("startWindow" in session.fetch).toBe(false);
    };
    await run(); // cold
    now += 25 * HOUR;
    site.site["/sitemap.xml"] = "<urlset><url><loc>https://s.example/b</loc></url></urlset>";
    await run(); // revalidation finds a change, then rediscovery
    expect(windows).toBe(0);
  });
});
