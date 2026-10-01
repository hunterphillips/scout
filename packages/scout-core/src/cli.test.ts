import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteCatalogSchema } from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifyFetch } from "./catalog/verifyTargets.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "./fetch/guardedFetch.js";

const ORIGIN = "https://s.example";

let home: string;
let events: { name: string; fields: DiagnosticFields }[];
const diagnostics: Diagnostics = { event: (name, fields = {}) => void events.push({ name, fields }), failures: 0 };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-cli-"));
  events = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A fake site with a 30-entry sitemap; counts requests. */
function fakeSite(files: Record<string, string> = {}) {
  const locs = Array.from({ length: 30 }, (_, i) => `<url><loc>${ORIGIN}/p/item-${i}</loc></url>`).join("");
  const site: Record<string, string> = { "/sitemap.xml": `<urlset>${locs}</urlset>`, ...files };
  const requests: string[] = [];
  const guardedFetch = async (url: string, _options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    requests.push(url);
    const body = site[new URL(url).pathname];
    if (body === undefined) return { kind: "absent", status: 404 };
    return { kind: "ok", status: 200, body, bytes: new TextEncoder().encode(body), etag: `"${body.length}"`, finalUrl: url };
  };
  return { guardedFetch, requests };
}

function io(deps: object = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (t: string) => void (stdout += t),
      stderr: (t: string) => void (stderr += t),
      env: { SCOUT_HOME: home },
      deps: { clock: { now: () => 1_000_000_000_000 }, sleep: async () => undefined, diagnostics, ...deps },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe("runCli", () => {
  it("importing the module performs no I/O", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const writeErr = vi.spyOn(process.stderr, "write");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const mod = await import("./cli.js");
      expect(typeof mod.runCli).toBe("function");
      expect(write).not.toHaveBeenCalled();
      expect(writeErr).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(readdirSync(home)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("catalog prints the summary and the first 20 candidates, cached under SCOUT_HOME", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });

    const code = await runCli(["catalog", ORIGIN], run.io);

    expect(code).toBe(0);
    const out = run.out();
    expect(out).toMatch(/source\s+miss/);
    expect(out).toMatch(/candidates\s+30 \(published 0, image_title 0, slug 30\)/);
    // The request count is the paced fetch's own: every request that reached guardedFetch.
    expect(out).toMatch(new RegExp(`requests\\s+${site.requests.length}, refused 0, \\d+ decoded bytes received`));
    expect(out).toMatch(/time\s+\d+ ms/);
    const rows = out.split("\n").filter((line) => /^c[0-9a-z]+ {2}slug {2}/.test(line));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain(`${ORIGIN}/p/item-0`);
    expect(existsSync(join(home, "cache", "catalog"))).toBe(true);

    // A second run inside 24 h is served from the cache with no request.
    site.requests.length = 0;
    const again = io({ guardedFetch: site.guardedFetch });
    expect(await runCli(["catalog", ORIGIN], again.io)).toBe(0);
    expect(site.requests).toEqual([]);
    expect(again.out()).toMatch(/source\s+fresh/);
    expect(again.out()).toMatch(/requests\s+0, refused 0, 0 decoded bytes received/);
  });

  it("catalog --refresh revalidates despite a fresh cache", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    await runCli(["catalog", ORIGIN], io({ guardedFetch: site.guardedFetch }).io);
    site.requests.length = 0;

    const run = io({ guardedFetch: site.guardedFetch });
    expect(await runCli(["catalog", ORIGIN, "--refresh"], run.io)).toBe(0);
    expect(site.requests.length).toBeGreaterThan(0);
  });

  it("catalog --json prints the SiteCatalog", async () => {
    const { runCli } = await import("./cli.js");
    const run = io({ guardedFetch: fakeSite().guardedFetch });

    expect(await runCli(["catalog", ORIGIN, "--json"], run.io)).toBe(0);
    const catalog = SiteCatalogSchema.parse(JSON.parse(run.out()));
    expect(catalog.origin).toBe(ORIGIN);
    expect(catalog.candidates).toHaveLength(30);
  });

  it("catalog exits 1 when the site yields nothing and a request failed", async () => {
    const { runCli } = await import("./cli.js");
    const failing = async (): Promise<GuardedFetchResult> => ({ kind: "error", reason: "network", message: "down" });
    const run = io({ guardedFetch: failing });

    expect(await runCli(["catalog", ORIGIN], run.io)).toBe(1);
    expect(run.err()).toContain("catalog failed");
  });

  it.each([
    [["catalog", "http://s.example"]],
    [["catalog", "https://s.example/path"]],
    [["catalog", "https://s.example/?q=1"]],
    [["catalog", "not a url"]],
    [["catalog"]],
    [["catalog", ORIGIN, "--bogus"]],
    [["verify"]],
    [["nope"]],
    [[]],
  ])("rejects %j with usage and exit 1, touching nothing", async (argv) => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });

    expect(await runCli(argv, run.io)).toBe(1);
    expect(run.err()).toContain("usage:");
    expect(run.out()).toBe("");
    expect(site.requests).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([["--help"], ["-h"], ["catalog", "--help"]])("%s prints usage to stdout and exits 0, touching nothing", async (...argv) => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });

    expect(await runCli(argv, run.io)).toBe(0);
    expect(run.out()).toContain("usage:");
    expect(run.err()).toBe("");
    expect(site.requests).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([
    ["http://s.example", "catalog: origin must be https"],
    ["https://s.example/path", "catalog: origin must not have a path"],
    ["https://s.example/?q=1", "catalog: origin must not have a query or fragment"],
    ["https://u:p@s.example", "catalog: origin must not carry credentials"],
    ["not a url", "catalog: not a URL"],
  ])("rejects origin %j with a one-line reason before the usage", async (origin, reason) => {
    const { runCli } = await import("./cli.js");
    const run = io({ guardedFetch: fakeSite().guardedFetch });

    expect(await runCli(["catalog", origin], run.io)).toBe(1);
    expect(run.err().startsWith(`${reason}\nusage:`)).toBe(true);
  });

  it("parseOrigin normalizes any bare https origin", async () => {
    const { parseOrigin } = await import("./cli.js");
    expect(parseOrigin("https://S.EXAMPLE")).toEqual({ ok: true, origin: "https://s.example" });
    expect(parseOrigin("https://s.example:443/")).toEqual({ ok: true, origin: "https://s.example" });
    expect(parseOrigin("https://s.example:8443")).toEqual({ ok: true, origin: "https://s.example:8443" });
    expect(parseOrigin("https://bücher.example")).toEqual({ ok: true, origin: "https://xn--bcher-kva.example" });
  });

  it("catalog accepts --refresh before the origin and an uppercase host", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });

    expect(await runCli(["catalog", "--refresh", "https://S.EXAMPLE"], run.io)).toBe(0);
    expect(run.out()).toMatch(/origin\s+https:\/\/s\.example\n/);
    expect(site.requests.every((url) => url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  it("a tampered inner fetchedAt is a cache miss, not a crash", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    expect(await runCli(["catalog", ORIGIN], io({ guardedFetch: site.guardedFetch }).io)).toBe(0);
    const dir = join(home, "cache", "catalog");
    const [name] = readdirSync(dir);
    const path = join(dir, name as string);
    const file = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...file, catalog: { ...file.catalog, fetchedAt: 1e20 } }));
    events = [];

    const run = io({ guardedFetch: site.guardedFetch });
    expect(await runCli(["catalog", ORIGIN], run.io)).toBe(0);
    expect(events).toContainEqual({ name: "catalog_cache_invalid", fields: { origin: ORIGIN, code: "fetched_at" } });
    expect(run.out()).toMatch(/source\s+miss/);
    expect(run.out()).toMatch(/fetched at\s+\d{4}-\d\d-\d\dT/);
  });

  it("formatTimestamp returns invalid for an unrepresentable date", async () => {
    const { formatTimestamp } = await import("./cli.js");
    expect(formatTimestamp(1e20)).toBe("invalid");
    expect(formatTimestamp(Number.NaN)).toBe("invalid");
    expect(formatTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("an unexpected throw exits 1 with a one-line error naming only its class", async () => {
    const { runCli } = await import("./cli.js");
    const throwing: Diagnostics = {
      event: () => {
        throw new RangeError(`bad value from ${ORIGIN}/secret-path`);
      },
      failures: 0,
    };
    const run = io({ guardedFetch: fakeSite().guardedFetch, diagnostics: throwing });

    expect(await runCli(["catalog", ORIGIN], run.io)).toBe(1);
    expect(run.err()).toBe("error: RangeError\n");
    expect(run.out()).toBe("");
  });

  it("verify refuses more than 10 URLs before fetching anything", async () => {
    const { runCli } = await import("./cli.js");
    const calls: string[] = [];
    const verifyFetch: VerifyFetch = async (url) => {
      calls.push(url);
      return { kind: "absent", status: 404 };
    };
    const urls = Array.from({ length: 11 }, (_, i) => `${ORIGIN}/p${i}`);
    const run = io({ verifyFetch });

    expect(await runCli(["verify", ...urls], run.io)).toBe(1);
    expect(run.err().startsWith("verify: at most 10 URLs\nusage:")).toBe(true);
    expect(calls).toEqual([]);

    const ten = io({ verifyFetch });
    expect(await runCli(["verify", ...urls.slice(0, 10)], ten.io)).toBe(0);
    expect(calls).toHaveLength(10);
  });

  it("verify refuses URLs on more than one origin before fetching anything", async () => {
    const { runCli } = await import("./cli.js");
    const calls: string[] = [];
    const verifyFetch: VerifyFetch = async (url) => {
      calls.push(url);
      return { kind: "absent", status: 404 };
    };
    const run = io({ verifyFetch });

    expect(await runCli(["verify", `${ORIGIN}/a`, "https://other.example/b"], run.io)).toBe(1);
    expect(run.err().startsWith("verify: all URLs must share one origin\nusage:")).toBe(true);
    expect(run.err()).toContain("all on one origin");

    const bad = io({ verifyFetch });
    expect(await runCli(["verify", "not a url", `${ORIGIN}/a`], bad.io)).toBe(1);
    expect(bad.err().startsWith("verify: the first URL is not a URL with an origin\nusage:")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("verifyOrigin takes the first URL's origin and lets unparseable later URLs through", async () => {
    const { verifyOrigin } = await import("./cli.js");
    expect(verifyOrigin([`${ORIGIN}/a`, "https://S.example:443/b", "not a url"])).toEqual({ ok: true, origin: ORIGIN });
    expect(verifyOrigin([`${ORIGIN}/a`, "https://s.example:8443/b"])).toMatchObject({ ok: false });
  });

  it("verify prints one href or drop line per URL", async () => {
    const { runCli } = await import("./cli.js");
    const calls: string[] = [];
    const verifyFetch: VerifyFetch = async (url) => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/payments/subscriptions") {
        return { kind: "ok", status: 200, body: "<html></html>", bytes: new Uint8Array(), contentType: "text/html", finalUrl: url };
      }
      return { kind: "absent", status: 404 };
    };
    const run = io({ verifyFetch });

    const code = await runCli(["verify", `${ORIGIN}/payments/subscriptions.md`, `${ORIGIN}/gone`, `${ORIGIN}/twinless.md`, `${ORIGIN}/x`], run.io);

    expect(code).toBe(0);
    const lines = run.out().split("\n");
    expect(lines[0]).toBe(`${ORIGIN}/payments/subscriptions.md  ->  ${ORIGIN}/payments/subscriptions`);
    expect(lines[1]).toBe(`${ORIGIN}/gone  ->  dropped: not_found`);
    expect(lines[2]).toBe(`${ORIGIN}/twinless.md  ->  ${ORIGIN}/twinless.md`);
    expect(lines[3]).toBe(`${ORIGIN}/x  ->  dropped: not_found`);
    expect(calls).toHaveLength(4);
  });

  it("rank is a Phase 3 stub that exits 2 without touching anything", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });

    expect(await runCli(["rank", ORIGIN], run.io)).toBe(2);
    expect(run.err()).toContain("not available until Phase 3");
    expect(site.requests).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("discover prints one line per probe without resource text and caches under SCOUT_HOME", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite({ "/llms.txt": "# Site\n\nSECRET-ISH BODY\n" });
    const run = io({ guardedFetch: site.guardedFetch });

    expect(await runCli(["discover", ORIGIN], run.io)).toBe(0);
    expect(run.out()).toMatch(/^llms_txt\s+found\s+network/m);
    expect(run.out()).toMatch(/^agents_md\s+absent/m);
    expect(run.out()).not.toContain("SECRET-ISH");
    expect(existsSync(join(home, "cache", "discovery"))).toBe(true);

    const json = io({ guardedFetch: site.guardedFetch });
    expect(await runCli(["discover", ORIGIN, "--json"], json.io)).toBe(0);
    expect(json.out()).not.toContain("SECRET-ISH");
    expect(JSON.parse(json.out()).items[0]).toMatchObject({ kind: "llms_txt", status: "found", source: "cache" });
  });

  it("discover exits 1 when robots.txt errored and nothing was found, 0 when only absent", async () => {
    const { runCli } = await import("./cli.js");
    const down = async (url: string): Promise<GuardedFetchResult> =>
      new URL(url).pathname === "/robots.txt" ? { kind: "error", reason: "network", message: "reset" } : { kind: "absent", status: 404 };
    const failed = io({ guardedFetch: down });
    expect(await runCli(["discover", ORIGIN], failed.io)).toBe(1);
    expect(failed.out()).toMatch(/^robots\s+error/m);

    const empty = io({ guardedFetch: fakeSite().guardedFetch });
    expect(await runCli(["discover", ORIGIN, "--refresh"], empty.io)).toBe(0);
  });

  it("discover refuses a non-origin before fetching anything", async () => {
    const { runCli } = await import("./cli.js");
    const site = fakeSite();
    const run = io({ guardedFetch: site.guardedFetch });
    expect(await runCli(["discover", `${ORIGIN}/path`], run.io)).toBe(1);
    expect(site.requests).toEqual([]);
  });
});
