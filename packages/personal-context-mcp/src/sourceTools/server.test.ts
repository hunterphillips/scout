// The five tools through a real McpServer and Client over the SDK's in-memory transport.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../config.js";
import { link, makeFixture, mdSource, observation, runFiles, SENTINEL, treeState, write, type Fixture } from "../test-support/sourceFixture.js";
import type { EvidenceLedger } from "./evidence.js";
import type { FetchLike } from "./focus.js";
import type { RunSnapshot } from "./runFiles.js";
import { createSourceToolsServer } from "./server.js";

const FOCUS_URL = "http://127.0.0.1:4242/api/focus";
const QUERY_SENTINEL = "querysentinel-91c2";

const fixtures: Fixture[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const f of fixtures.splice(0)) f.cleanup();
});

interface Harness {
  f: Fixture;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any>; text: string }>;
  audit(): Record<string, any>[];
  ledger(): EvidenceLedger;
  fetch: ReturnType<typeof vi.fn>;
}

async function harness(
  opts: {
    sources?: (f: Fixture) => SourceConfig[];
    snap?: Partial<RunSnapshot>;
    fetch?: () => Promise<Response> | Response;
  } = {},
): Promise<Harness> {
  const f = makeFixture();
  fixtures.push(f);
  const sources = opts.sources ? opts.sources(f) : [mdSource(f.notes), { id: "focus", kind: "focus_http", enabled: true, url: FOCUS_URL } as SourceConfig];
  const fetch = vi.fn(async () => (opts.fetch ? opts.fetch() : new Response(JSON.stringify({ items: [{ id: "a", title: "Ship billing", status: "open" }] }))));
  let ledger: EvidenceLedger | undefined;
  const server = createSourceToolsServer({
    runDir: f.runDir,
    files: runFiles(sources, opts.snap),
    clock: { now: () => Date.parse("2026-09-30T12:00:00Z") },
    fetch: fetch as unknown as FetchLike,
    exclusion: { home: f.home },
    focusTimeoutMs: 100,
    onLedger: (l) => (ledger = l),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return {
    f,
    client,
    fetch,
    ledger: () => ledger!,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
      const text = r.content[0]!.text;
      expect(r.structuredContent).toEqual(JSON.parse(text));
      return { isError: r.isError === true, body: r.structuredContent, text };
    },
    audit() {
      const p = join(f.runDir, "audit.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    },
  };
}

describe("catalog", () => {
  it("exposes exactly the five read-only tools", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_focus", "list_sources", "read_recent_activity", "read_source", "search_source"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("lists sources with kinds, purposes and availability, and issues no evidence", async () => {
    const h = await harness({
      sources: (f) => [
        mdSource(f.notes),
        mdSource(join(f.home, "saved"), { id: "saved", purpose: "task_recall" }),
        mdSource(join(f.base, "missing"), { id: "gone" }),
        { id: "focus", kind: "focus_http", enabled: true, url: FOCUS_URL } as SourceConfig,
        mdSource(f.notes, { id: "off", enabled: false }),
      ],
    });
    write(join(h.f.home, "saved", "list.md"), "saved");
    const { body } = await h.call("list_sources");
    expect(body.sources).toEqual([
      { id: "notes", kind: "markdown_dir", availability: "ok" },
      { id: "saved", kind: "markdown_dir", purpose: "task_recall", availability: "ok", note: "recall material, not stated priorities" },
      { id: "gone", kind: "markdown_dir", availability: "unavailable: unresolvable" },
      { id: "focus", kind: "focus_http", availability: "ok" },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/"e\d+"/);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("activity", () => {
  it("returns snapshot observations newest first, each with an evidence id", async () => {
    const h = await harness({ snap: { observations: [observation(3), observation(2), observation(1)] } });
    const { body } = await h.call("read_recent_activity", { limit: 2 });
    expect(body.observations.map((o: any) => [o.evidenceId, o.title, o.text])).toEqual([
      ["e1", "issue 3", "activity text 3"],
      ["e2", "issue 2", "activity text 2"],
    ]);
    expect(h.audit().at(-1)!.evidence).toEqual([
      { id: "e1", kind: "activity", sourceId: "activity", path: "o3" },
      { id: "e2", kind: "activity", sourceId: "activity", path: "o2" },
    ]);
  });
});

describe("activity packing", () => {
  const ctl = "\x01".repeat(8192); // ~48 KiB once JSON-escaped

  it("packs a hostile snapshot newest first into the call's room, and later tools still work", async () => {
    const obs = Array.from({ length: 10 }, (_, i) => observation(10 - i, { text: ctl }));
    const h = await harness({ snap: { observations: obs } });
    const a = await h.call("read_recent_activity");
    expect(a.isError).toBe(false);
    expect(a.body.truncated).toBe(true);
    expect(a.body.observations).toEqual([]);
    expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(32 * 1024);
    const s = await h.call("search_source", { sourceId: "notes", query: "billing" });
    expect(s.body.status).toBe("ok");
    expect((await h.call("list_sources")).body.status).toBe("ok");
  });

  it("drops the oldest entries first and keeps ids gap-free", async () => {
    const big = "q".repeat(12 * 1024);
    const obs = [observation(3, { text: big }), observation(2, { text: big }), observation(1, { text: big })];
    const h = await harness({ snap: { observations: obs } });
    const a = await h.call("read_recent_activity");
    expect(a.body.observations.map((o: any) => [o.evidenceId, o.title])).toEqual([
      ["e1", "issue 3"],
      ["e2", "issue 2"],
    ]);
    expect(a.body.truncated).toBe(true);
    expect(h.audit().at(-1)!.evidence.map((e: any) => e.path)).toEqual(["o3", "o2"]);
    expect((await h.call("read_recent_activity", { limit: 1 })).body).toMatchObject({ truncated: false, observations: [{ evidenceId: "e3" }] });
  });
});

describe("search and read", () => {
  it("returns hits with paths, line ranges, snippets and fresh evidence ids", async () => {
    const h = await harness();
    const { body } = await h.call("search_source", { sourceId: "notes", query: "billing invoices" });
    expect(body.hits).toEqual([
      { evidenceId: "e1", path: "billing-migration.md", lines: [3, 3], snippet: "We move invoices to usage-based billing." },
      { evidenceId: "e2", path: "projects/scout.md", lines: [2, 3], snippet: "It reads the billing notes when invoices matter." },
    ]);
    const r = await h.call("read_source", { sourceId: "notes", path: "billing-migration.md", startLine: 3, endLine: 4 });
    expect(r.body).toMatchObject({ evidenceId: "e3", path: "billing-migration.md", lines: [3, 4] });
  });

  it("labels task-recall sources in their results", async () => {
    const h = await harness({ sources: (f) => [mdSource(f.notes, { id: "saved", purpose: "task_recall" })] });
    const s = await h.call("search_source", { sourceId: "saved", query: "billing" });
    expect(s.body).toMatchObject({ purpose: "task_recall", note: "recall material, not stated priorities" });
    const r = await h.call("read_source", { sourceId: "saved", path: "todo.txt" });
    expect(r.body).toMatchObject({ purpose: "task_recall", note: "recall material, not stated priorities" });
  });

  it("cannot reach ~/.ssh/id_rsa whatever the arguments say", async () => {
    const h = await harness();
    link(join(h.f.home, ".ssh", "id_rsa"), join(h.f.notes, "key.md"));
    link(join(h.f.home, ".ssh"), join(h.f.notes, "sshdir"));
    const attempts = [
      "~/.ssh/id_rsa",
      "../.ssh/id_rsa",
      "../../home/.ssh/id_rsa",
      join(h.f.home, ".ssh", "id_rsa"),
      join(homedir(), ".ssh", "id_rsa"),
      "/etc/passwd",
      "key.md",
      "sshdir/id_rsa",
      "id_rsa",
      "billing-migration.md\0../../.ssh/id_rsa",
      "",
    ];
    for (const path of attempts) {
      const r = await h.call("read_source", { sourceId: "notes", path });
      expect(r.isError).toBe(true);
      expect(r.body.status).toBe("error");
      expect(r.text).not.toContain(SENTINEL);
      expect(r.text).not.toContain(h.f.home);
    }
    for (const sourceId of ["../notes", "ssh", "~"]) {
      const r = await h.call("read_source", { sourceId, path: "id_rsa" });
      expect(r.body).toEqual({ status: "error", code: "unknown-source" });
    }
    const s = await h.call("search_source", { sourceId: "notes", query: "ssh KEY" });
    expect(s.text).not.toContain(SENTINEL);
    expect(readFileSync(join(h.f.runDir, "audit.jsonl"), "utf8")).not.toContain(SENTINEL);
  });

  it("never lists or searches excluded names", async () => {
    const h = await harness();
    const { body, text } = await h.call("search_source", { sourceId: "notes", query: "billing" });
    expect(body.hits.map((x: any) => x.path).sort()).toEqual(["billing-migration.md", "billing-migration.md", "projects/scout.md", "todo.txt"].sort());
    expect(text).not.toContain(SENTINEL);
  });

  it("rejects search on a Focus source and bad queries with fixed codes", async () => {
    const h = await harness();
    expect((await h.call("search_source", { sourceId: "focus", query: "x" })).body).toEqual({ status: "error", code: "unsupported-source" });
    expect((await h.call("search_source", { sourceId: "notes", query: "   " })).body).toEqual({ status: "error", code: "invalid-query" });
  });
});

describe("registry projects", () => {
  function registrySources(f: Fixture): SourceConfig[] {
    const reg = join(f.home, "workspace", "second-brain", "notes");
    write(join(f.home, "work", "alpha", "thoughts", "shared", "plan.md"), "alpha billing plan");
    write(join(f.home, "work", "alpha", "README.md"), `alpha billing readme ${SENTINEL}`);
    write(join(f.home, "work", "beta", "thoughts", "shared", "plan.md"), `beta billing plan ${SENTINEL}`);
    write(join(reg, "projects", "alpha.md"), "---\nrepo:\n  - ~/work/alpha\n---\nbilling registry note\n");
    write(join(reg, "projects", "beta.md"), "---\nrepo: ~/work/beta\n---\n");
    write(join(reg, "projects", "home.md"), "---\nrepo: ~\n---\n");
    return [
      { id: "projects", kind: "registry_projects", enabled: true, registry: reg, subpath: "thoughts/shared", enabledProjects: ["alpha", "home"] } as SourceConfig,
    ];
  }

  it("lists found projects and which are enabled; a repo at ~ is unavailable", async () => {
    const h = await harness({ sources: registrySources });
    const { body } = await h.call("list_sources");
    expect(body.sources[0].projects).toEqual([
      { name: "alpha", availability: "ok" },
      { name: "home", availability: "unavailable: too-broad" },
    ]);
    expect(body.sources[0].disabledProjectCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain("beta");
  });

  it("searches and reads only enabled projects, under <repo>/thoughts/shared only", async () => {
    const h = await harness({ sources: registrySources });
    const s = await h.call("search_source", { sourceId: "projects", query: "billing" });
    expect(s.body.hits.map((x: any) => x.path)).toEqual(["alpha/plan.md"]);
    expect(s.text).not.toContain(SENTINEL);
    const r = await h.call("read_source", { sourceId: "projects", path: "alpha/plan.md" });
    expect(r.body).toMatchObject({ status: "ok", path: "alpha/plan.md", text: "alpha billing plan" });
    for (const path of ["beta/plan.md", "alpha/../README.md", "alpha/../../README.md", "home/plan.md", "projects/alpha.md", "alpha"]) {
      const d = await h.call("read_source", { sourceId: "projects", path });
      expect(d.isError).toBe(true);
      expect(d.text).not.toContain(SENTINEL);
    }
  });
});

describe("focus", () => {
  it("returns items with evidence ids from one GET of the configured URL only", async () => {
    const h = await harness();
    const { body } = await h.call("get_focus");
    expect(body).toEqual({ status: "ok", sourceId: "focus", items: [{ evidenceId: "e1", title: "Ship billing" }] });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]![0]).toBe(FOCUS_URL);
    expect(h.audit().at(-1)!.evidence).toEqual([{ id: "e1", kind: "focus", sourceId: "focus", path: "a" }]);
  });

  it.each([
    ["down", () => Promise.reject(new TypeError("fetch failed"))],
    ["500", () => new Response("x", { status: 500 })],
    ["bad JSON", () => new Response("{", { status: 200 })],
    ["hanging", () => new Promise<Response>(() => {})],
  ])("is unavailable when Focus is %s, with no retry", async (_l, respond) => {
    const h = await harness({ fetch: respond as () => Promise<Response> });
    const r = await h.call("get_focus");
    expect(r.body.status).toBe("unavailable");
    expect(r.isError).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.every((c) => c[0] === FOCUS_URL)).toBe(true);
  });

  it.each([
    ["too-large", () => new Response("x".repeat(300 * 1024))],
    ["http-status", () => new Response("", { status: 302, headers: { location: "http://example.com/" } })],
  ])("reports %s as unavailable and fetches with redirect: error", async (reason, respond) => {
    const h = await harness({ fetch: respond });
    expect((await h.call("get_focus")).body).toEqual({ status: "unavailable", sourceId: "focus", reason });
    expect(h.fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(h.audit().at(-1)).toMatchObject({ tool: "get_focus", status: "unavailable", code: reason });
  });

  it("is unavailable when no Focus source is granted, without fetching", async () => {
    const h = await harness({ sources: (f) => [mdSource(f.notes)] });
    expect((await h.call("get_focus")).body).toEqual({ status: "unavailable", reason: "not-configured" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("budgets", () => {
  it("refuses the 21st call with budget_exhausted and audits it", async () => {
    const h = await harness();
    for (let i = 0; i < 20; i++) expect((await h.call("list_sources")).isError).toBe(false);
    const over = await h.call("search_source", { sourceId: "notes", query: "billing" });
    expect(over).toMatchObject({ isError: true, body: { status: "budget_exhausted" } });
    expect(h.audit().at(-1)).toMatchObject({ tool: "search_source", status: "budget_exhausted", evidence: [] });
    expect((await h.call("list_sources")).body).toEqual({ status: "budget_exhausted" });
  });

  it("honors a lower call budget from the snapshot", async () => {
    const h = await harness({ snap: { budgets: { maxCalls: 2, maxTotalBytes: 128 * 1024 } } });
    await h.call("list_sources");
    await h.call("list_sources");
    expect((await h.call("list_sources")).body).toEqual({ status: "budget_exhausted" });
  });

  it("refuses a result that would pass 128 KiB, commits none of its ids, and stays exhausted", async () => {
    const h = await harness();
    write(join(h.f.notes, "wide.md"), Array.from({ length: 200 }, () => "w".repeat(1000)).join("\n"));
    let total = 0;
    let last: Awaited<ReturnType<Harness["call"]>> | undefined;
    const issued: string[] = [];
    for (let i = 0; i < 12; i++) {
      last = await h.call("read_source", { sourceId: "notes", path: "wide.md" });
      if (last.isError) break;
      issued.push(last.body.evidenceId);
      total += Buffer.byteLength(last.text);
    }
    expect(last!.body).toEqual({ status: "budget_exhausted" });
    expect(total).toBeLessThanOrEqual(128 * 1024);
    expect(h.ledger().all().map((e) => e.id)).toEqual(issued);
    expect((await h.call("read_recent_activity", { limit: 1 })).body).toEqual({ status: "budget_exhausted" });
    // The next id issued after exhaustion would have continued the sequence: nothing was skipped.
    expect(issued).toEqual(issued.map((_, i) => `e${i + 1}`));
  });

  it("refuses one oversized result as too_large, alone, and the run goes on", async () => {
    const h = await harness();
    write(join(h.f.notes, "ctl.md"), "\x01".repeat(16 * 1024)); // 16 KiB of text, ~96 KiB of JSON
    const big = await h.call("read_source", { sourceId: "notes", path: "ctl.md" });
    expect(big).toMatchObject({ isError: true, body: { status: "too_large" } });
    expect(h.audit().at(-1)).toMatchObject({ tool: "read_source", status: "too-large", evidence: [] });
    expect(h.ledger().all()).toEqual([]);
    const next = await h.call("read_source", { sourceId: "notes", path: "todo.txt" });
    expect(next.body).toMatchObject({ status: "ok", evidenceId: "e1" });
  });

  it("marks per-call scan caps as truncated", async () => {
    const h = await harness();
    write(join(h.f.notes, "big.md"), "x\n".repeat(200 * 1024));
    const { body } = await h.call("search_source", { sourceId: "notes", query: "billing" });
    expect(body.truncated).toBe(true);
  });
});

describe("invalid arguments", () => {
  it.each([
    ["read_source", { sourceId: "notes", path: 12345 }],
    ["read_source", { sourceId: "notes", path: `${QUERY_SENTINEL}/`.repeat(100) }],
    ["read_source", { sourceId: "notes" }],
    ["read_source", { sourceId: "notes", path: "todo.txt", startLine: 0 }],
    ["search_source", { sourceId: "notes", query: "billing", limit: 99 }],
    ["read_recent_activity", { limit: "ten" }],
  ])("%s with bad arguments is counted, audited without values, and answered with a fixed code", async (tool, args) => {
    const h = await harness({ snap: { budgets: { maxCalls: 2, maxTotalBytes: 128 * 1024 } } });
    const r = await h.call(tool, args as Record<string, unknown>);
    expect(r).toMatchObject({ isError: true, body: { status: "error", code: "invalid-args" } });
    const line = h.audit().at(-1)!;
    expect(line).toMatchObject({ tool, status: "invalid-args", code: "invalid-args", evidence: [] });
    expect(JSON.stringify(h.audit())).not.toContain(QUERY_SENTINEL);
    await h.call("list_sources");
    expect((await h.call("list_sources")).body).toEqual({ status: "budget_exhausted" });
  });

  it("still advertises typed input schemas", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const read = tools.find((t) => t.name === "read_source")!;
    expect(read.inputSchema.properties).toMatchObject({ path: { type: "string", maxLength: 1024 }, startLine: { type: "integer", minimum: 1 } });
    expect(read.inputSchema.required).toEqual(["sourceId", "path"]);
  });
});

describe("evidence and audit", () => {
  it("audits the reason behind a denied read, without telling the model", async () => {
    const h = await harness();
    const r = await h.call("read_source", { sourceId: "notes", path: "secrets/billing.md" });
    expect(r.body).toEqual({ status: "error", code: "denied" });
    expect(h.audit().at(-1)).toMatchObject({ status: "error", code: "denied", detail: "excluded" });
  });

  it("issues sequential, unique ids across tools and keeps the map out of every result", async () => {
    const h = await harness();
    const results = [
      await h.call("read_recent_activity"),
      await h.call("search_source", { sourceId: "notes", query: `billing` }),
      await h.call("read_source", { sourceId: "notes", path: "todo.txt" }),
      await h.call("get_focus"),
      await h.call("list_sources"),
    ];
    const ids = results.flatMap((r) => [...r.text.matchAll(/"evidenceId":"(e\d+)"/g)].map((m) => m[1]));
    expect(ids).toEqual(ids.map((_, i) => `e${i + 1}`));
    const audited = h.audit().flatMap((l) => (l.evidence ?? []).map((e: any) => e.id));
    expect(audited).toEqual(ids);
    expect(h.ledger().all().map((e) => e.id)).toEqual(ids);
    for (const r of results) {
      expect(r.text).not.toContain('"sourceId":"activity"');
      expect(r.text).not.toContain('"kind":"note"');
    }
  });

  it("writes one line per call with evidence, hash, bytes and time, and never text or queries", async () => {
    const h = await harness();
    write(join(h.f.notes, "sentinel.md"), `${QUERY_SENTINEL} billing ${SENTINEL}`);
    await h.call("search_source", { sourceId: "notes", query: `${QUERY_SENTINEL} billing` });
    await h.call("read_source", { sourceId: "notes", path: "sentinel.md" });
    await h.call("read_source", { sourceId: "notes", path: `../${QUERY_SENTINEL}.md` });
    await h.call("get_focus");
    const lines = h.audit();
    expect(lines.map((l) => l.tool)).toEqual(["search_source", "read_source", "read_source", "get_focus"]);
    for (const l of lines) {
      expect(l).toMatchObject({ type: "call", argsHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(typeof l.bytes).toBe("number");
      expect(typeof l.ms).toBe("number");
    }
    expect(lines[0]!.evidence[0]).toEqual({ id: "e1", kind: "note", sourceId: "notes", path: "sentinel.md", lines: [1, 1] });
    expect(lines[2]).toMatchObject({ status: "error", code: "invalid-path", evidence: [] });
    const raw = readFileSync(join(h.f.runDir, "audit.jsonl"), "utf8");
    for (const s of [SENTINEL, QUERY_SENTINEL, "billing", "Ship billing", FOCUS_URL, "127.0.0.1"]) expect(raw).not.toContain(s);
    expect(statSync(join(h.f.runDir, "audit.jsonl")).mode & 0o777).toBe(0o600);
  });
});

describe("no writes", () => {
  it("leaves every source tree untouched; audit.jsonl is the only new file in the run dir", async () => {
    const h = await harness({
      sources: (f) => {
        const reg = join(f.home, "workspace", "second-brain", "notes");
        write(join(f.home, "work", "alpha", "thoughts", "shared", "plan.md"), "alpha billing plan");
        write(join(reg, "projects", "alpha.md"), "---\nrepo: ~/work/alpha\n---\n");
        return [
          mdSource(f.notes),
          { id: "projects", kind: "registry_projects", enabled: true, registry: reg, subpath: "thoughts/shared", enabledProjects: ["alpha"] } as SourceConfig,
          { id: "focus", kind: "focus_http", enabled: true, url: FOCUS_URL } as SourceConfig,
        ];
      },
    });
    link(join(h.f.outside, "plain.md"), join(h.f.notes, "escape.md"));
    const before = treeState(h.f.home);
    const outsideBefore = treeState(h.f.outside);
    const runBefore = readdirSync(h.f.runDir);
    await h.call("list_sources");
    await h.call("read_recent_activity");
    await h.call("search_source", { sourceId: "notes", query: "billing" });
    await h.call("search_source", { sourceId: "projects", query: "billing" });
    await h.call("read_source", { sourceId: "notes", path: "billing-migration.md" });
    await h.call("read_source", { sourceId: "projects", path: "alpha/plan.md" });
    await h.call("read_source", { sourceId: "notes", path: "escape.md" });
    await h.call("get_focus");
    expect(treeState(h.f.home)).toEqual(before);
    expect(treeState(h.f.outside)).toEqual(outsideBefore);
    expect(runBefore).toEqual([]);
    expect(readdirSync(h.f.runDir)).toEqual(["audit.jsonl"]);
  });
});
