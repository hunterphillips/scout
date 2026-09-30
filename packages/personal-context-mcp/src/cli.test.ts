// `pcm` against temp homes and an in-process test server (fake CLI wrapper). No real
// claude, no network beyond 127.0.0.1.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidatesFromJson, runCli, USAGE } from "./cli.js";
import { loadConfig, sourceGrantRevision } from "./config.js";
import { cleanupAll, CLI_JS, makeServerFixture, rankRequest, startServer, token, type ServerFixture } from "./test-support/serverFixture.js";

afterEach(cleanupAll);

async function pcm(fx: ServerFixture, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), env: fx.env });
  return { code, out, err };
}

const catalog = {
  origin: "https://docs.example.com",
  version: "v1",
  fetchedAt: 1,
  truncated: false,
  errors: [],
  candidates: [
    { id: "c0", sourceUrl: "https://docs.example.com/billing", title: "Usage billing guide", description: "metering", labelQuality: "published", provenance: "llms.txt" },
    { id: "c1", sourceUrl: "https://docs.example.com/webhooks", title: "Webhooks", labelQuality: "slug", provenance: "sitemap" },
    { id: "c2", sourceUrl: "https://docs.example.com/offsite.png", title: "Team offsite", labelQuality: "image_title", provenance: "sitemap-image" },
  ],
};

describe("pcm: help and misuse", () => {
  it("--help exits 0 with usage on stdout", async () => {
    const fx = makeServerFixture();
    expect(await pcm(fx, "--help")).toEqual({ code: 0, out: USAGE, err: "" });
  });

  it("misuse exits 1 with usage on stderr", async () => {
    const fx = makeServerFixture();
    for (const argv of [[], ["bogus"], ["rank"], ["rank", "--origin", "https://a.example"], ["status", "extra"], ["sources", "enable"], ["rank", "--origin"]]) {
      const r = await pcm(fx, ...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toBe(USAGE);
    }
  });

  it("the built bin runs --help", () => {
    const r = spawnSync(process.execPath, [CLI_JS, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });
});

describe("pcm: candidates files", () => {
  it("maps a Scout catalog (and a cache file) to c1..cN", () => {
    const want = [
      { id: "c1", title: "Usage billing guide", description: "metering", labelQuality: "published" },
      { id: "c2", title: "Webhooks", labelQuality: "slug" },
      { id: "c3", title: "Team offsite", labelQuality: "image_title" },
    ];
    expect(candidatesFromJson(catalog)).toEqual(want);
    expect(candidatesFromJson({ schemaVersion: 3, catalog })).toEqual(want);
    expect(candidatesFromJson([{ id: "x", title: "t", labelQuality: "slug" }])).toEqual([{ id: "x", title: "t", labelQuality: "slug" }]);
    expect(candidatesFromJson({ nope: 1 })).toBeUndefined();
    expect(candidatesFromJson([{ id: "x" }])).toBeUndefined();
  });
});

describe("pcm: rank and status against a running server", () => {
  it("rank with a candidates array and with a saved catalog", async () => {
    const fx = makeServerFixture({ mode: "empty" });
    await startServer(fx);
    const arr = join(fx.base, "cands.json");
    writeFileSync(arr, JSON.stringify(rankRequest().candidates));
    const r1 = await pcm(fx, "rank", "--origin", "https://docs.example.com", "--candidates", arr, "--name", "Docs");
    expect(r1.err).toBe("");
    expect(r1.code).toBe(0);
    expect(JSON.parse(r1.out)).toMatchObject({ status: "empty" });

    fx.setMode("ok");
    const cat = join(fx.base, "catalog.json");
    writeFileSync(cat, JSON.stringify(catalog));
    const r2 = await pcm(fx, "rank", "--origin", "https://docs.example.com", "--candidates", cat, "--max-results", "2", "--deadline-ms", "20000");
    expect(r2.code).toBe(0);
    const out = JSON.parse(r2.out);
    expect(out.status).toBe("ok");
    expect(out.items[0].id).toMatch(/^c[123]$/);
    expect(r2.out + r2.err).not.toContain(token(fx));
  });

  it("rank that is not ok/empty exits 2; a bad origin or file exits 1", async () => {
    const fx = makeServerFixture({ mode: "is_error" });
    await startServer(fx);
    const arr = join(fx.base, "cands.json");
    writeFileSync(arr, JSON.stringify(rankRequest().candidates));
    const r = await pcm(fx, "rank", "--origin", "https://docs.example.com", "--candidates", arr);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ status: "error" });
    expect((await pcm(fx, "rank", "--origin", "http://docs.example.com", "--candidates", arr)).code).toBe(1);
    writeFileSync(arr, "not json");
    expect((await pcm(fx, "rank", "--origin", "https://docs.example.com", "--candidates", arr)).code).toBe(1);
  });

  it("status when up prints pid/port and context_status; when down exits 1", async () => {
    const fx = makeServerFixture();
    const down = await pcm(fx, "status");
    expect(down.code).toBe(1);
    expect(down.out).toContain("not running");
    const { server } = await startServer(fx);
    const up = await pcm(fx, "status");
    expect(up.code).toBe(0);
    expect(up.out).toContain(`pid: ${process.pid}`);
    expect(up.out).toContain(`port: ${server.port}`);
    expect(up.out).toContain(server.serviceInstanceId);
    expect(up.out).not.toContain(token(fx));
    await server.shutdown("sigterm");
    expect((await pcm(fx, "status")).code).toBe(1);
  });

  it("rank with no service exits 2", async () => {
    const fx = makeServerFixture();
    // A token exists but nothing listens on the configured port.
    await (await startServer(fx)).server.shutdown("sigterm");
    const arr = join(fx.base, "cands.json");
    writeFileSync(arr, JSON.stringify(rankRequest().candidates));
    const r = await pcm({ ...fx, env: { ...fx.env, PCM_PORT: "1" } }, "rank", "--origin", "https://docs.example.com", "--candidates", arr);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unreachable");
  });

  it("reload with no server exits 1", async () => {
    const fx = makeServerFixture();
    const r = await pcm(fx, "reload");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not running");
  });
});

describe("pcm: sources", () => {
  function defaultsFixture(): ServerFixture {
    const fx = makeServerFixture();
    // The three shipped defaults, pointed at fixtures under the fake HOME.
    const brain = join(fx.home, "workspace", "second-brain", "notes");
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, "one.md"), "# one\n");
    writeFileSync(join(brain, "two.md"), "# two\n");
    writeFileSync(join(brain, ".env"), "SECRET=1\n");
    mkdirSync(join(brain, "secrets"));
    writeFileSync(join(brain, "secrets", "hidden.md"), "x\n");
    const repo = join(fx.home, "code", "alpha");
    mkdirSync(join(repo, "thoughts", "shared"), { recursive: true });
    writeFileSync(join(repo, "thoughts", "shared", "plan.md"), "plan\n");
    writeFileSync(join(brain, "alpha.md"), `---\nrepo: ~/code/alpha\n---\n# alpha\n`);
    writeFileSync(join(brain, "beta.md"), `---\nrepo: ~/code/beta\n---\n`);
    writeFileSync(
      join(fx.pcmHome, "config.json"),
      `{"claudePath": ${JSON.stringify(fx.claude)}, "x_scout_marker": {"keep": true}, "__proto__": {"polluted": 1}}`,
      { mode: 0o600 },
    );
    return fx;
  }

  it("lists the three defaults with counts, projects and the focus url", async () => {
    const fx = defaultsFixture();
    const r = await pcm(fx, "sources");
    expect(r.code).toBe(0);
    expect(r.out).toContain("second-brain-notes  markdown_dir  disabled");
    expect(r.out).toContain(`root: ${join(fx.home, "workspace", "second-brain", "notes")}`);
    expect(r.out).toContain("4 files"); // one, two, alpha, beta; .env and secrets/ skipped
    expect(r.out).toContain("project-thoughts  registry_projects  disabled");
    expect(r.out).toMatch(/project alpha: disabled/);
    expect(r.out).toMatch(/project beta: disabled/);
    expect(r.out).toContain("focus  focus_http  disabled");
    expect(r.out).toContain("url: http://127.0.0.1:4242/api/focus");
    expect(r.out).not.toContain("# one");
  });

  it("enable/disable round trip keeps unknown keys, writes no __proto__, and reports the grant revision", async () => {
    const fx = defaultsFixture();
    const cfgPath = join(fx.pcmHome, "config.json");
    const before = sourceGrantRevision(loadConfig(fx.pcmHome, fx.env));

    const en = await pcm(fx, "sources", "enable", "second-brain-notes");
    expect(en.code).toBe(0);
    const after = sourceGrantRevision(loadConfig(fx.pcmHome, fx.env));
    expect(after).not.toBe(before);
    expect(en.out).toContain(`sourceGrantRevision: ${after}`);
    expect(en.out).toContain("pcm reload");
    let text = readFileSync(cfgPath, "utf8");
    expect(JSON.parse(text).x_scout_marker).toEqual({ keep: true });
    expect(text).not.toContain("__proto__");
    expect(text).not.toContain("polluted");

    const proj = await pcm(fx, "sources", "enable", "project-thoughts", "--project", "alpha");
    expect(proj.code).toBe(0);
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).sources.find((s: { id: string }) => s.id === "project-thoughts").enabledProjects).toEqual(["alpha"]);
    expect((await pcm(fx, "sources", "enable", "project-thoughts", "--project", "nope")).code).toBe(1);
    expect((await pcm(fx, "sources", "enable", "second-brain-notes", "--project", "alpha")).code).toBe(1);
    expect((await pcm(fx, "sources", "enable", "unknown-id")).code).toBe(1);

    expect((await pcm(fx, "sources", "disable", "project-thoughts", "--project", "alpha")).code).toBe(0);
    expect((await pcm(fx, "sources", "disable", "second-brain-notes")).code).toBe(0);
    expect(sourceGrantRevision(loadConfig(fx.pcmHome, fx.env))).toBe(before);
    text = readFileSync(cfgPath, "utf8");
    expect(JSON.parse(text).x_scout_marker).toEqual({ keep: true });
    expect(text).not.toContain("__proto__");
  });
});
