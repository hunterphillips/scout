import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    expect(out).toMatch(/requests\s+\d+ \(0 refused\), \d+ bytes received/);
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
    expect(again.out()).toMatch(/requests\s+0 \(0 refused\), 0 bytes received/);
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
    [["--help"]],
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
});
