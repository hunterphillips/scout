// LIVE check: one real `claude -p` run through the service, billed to Hunter's Claude Code
// subscription. Opt-in only: `npm run test:live -w personal-context-mcp` (SCOUT_LIVE=1).
// The default `vitest run` never picks this file up (vitest.config.mjs excludes it).
//
// Throwaway PERSONAL_CONTEXT_HOME, every source disabled, synthetic page and candidates
// only. If the direct preflight is not `subscription`, the test skips: no inference runs.
//
// The run dir (and its audit.jsonl) is removed when the run ends, so "the audit recorded
// read_recent_activity" is checked through what the runner derived from that audit:
// runs.jsonl `sourceIds` contains `activity` (only an ok read_recent_activity call issues
// activity evidence), and the response cites `activity` evidence.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, describe, expect, it } from "vitest";
import { RankResponseSchema, type RankCandidate } from "../src/api.js";
import { resolveOnPath } from "../src/authPreflight.js";
import { runServer, type RunningServer } from "../src/server.js";

if (process.env.SCOUT_LIVE !== "1") {
  throw new Error("live test refused: set SCOUT_LIVE=1 (npm run test:live) to run the real claude once");
}

const CANDIDATES: RankCandidate[] = [
  ["Subscriptions overview", "How recurring billing works with Subscriptions"],
  ["Using webhooks with subscriptions", "Listen for subscription lifecycle events such as invoice.paid and customer.subscription.updated"],
  ["Webhook signature verification", "Check the Stripe-Signature header before trusting an event"],
  ["Testing webhooks locally with the Stripe CLI", "Forward events to your local endpoint"],
  ["Payment Intents API", "Build a custom payment flow"],
  ["Connect onboarding", "Onboard connected accounts to your platform"],
  ["Issuing cards", "Create and manage virtual and physical cards"],
  ["Terminal readers", "Accept in-person payments"],
  ["Radar rules", "Customize fraud rules"],
  ["Tax settings", "Configure automatic tax calculation"],
  ["Company careers", "Open roles"],
  ["Brand assets", "Logos and press kit"],
].map(([title, description], i) => ({ id: `c${i + 1}`, title: title!, description: description!, labelQuality: "published" }));

const base = realpathSync(mkdtempSync(join(tmpdir(), "pcm-live-")));
const home = join(base, "pcm");
let server: RunningServer | undefined;
const logs: string[] = [];

afterAll(async () => {
  await server?.shutdown("sigterm");
  rmSync(base, { recursive: true, force: true });
});

describe("live: one real rank through the service", () => {
  it("ranks with the real claude on the subscription route", async (ctx) => {
    const claudePath = resolveOnPath("claude", process.env.PATH);
    if (!claudePath) return ctx.skip("claude not found on PATH");
    mkdirSync(home, { mode: 0o700 });
    const sources = [
      { id: "second-brain-notes", kind: "markdown_dir", enabled: false, root: "~/workspace/second-brain/notes", exclude: [] },
      { id: "project-thoughts", kind: "registry_projects", enabled: false, registry: "~/workspace/second-brain/notes", subpath: "thoughts/shared", enabledProjects: [] },
      { id: "focus", kind: "focus_http", enabled: false, url: "http://127.0.0.1:4242/api/focus" },
    ];
    writeFileSync(join(home, "config.json"), JSON.stringify({ nodePath: process.execPath, claudePath, sources }, null, 2), { mode: 0o600 });

    server = await runServer({ env: { ...process.env, PERSONAL_CONTEXT_HOME: home, PCM_PORT: "0" }, log: (l) => logs.push(l) });
    const verdict = server.runner.preflight.verdict;
    if (verdict !== "subscription") {
      return ctx.skip(`preflight verdict is ${verdict} (${server.runner.preflight.reasons.join("; ")}); no inference run`);
    }

    const token = readFileSync(join(home, "token"), "utf8").trim();
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "pcm-live", version: "0" });
    await client.connect(transport as Transport);
    try {
      const obs = await client.callTool({
        name: "observe_activity",
        arguments: {
          sensor: "scout",
          kind: "viewed_page",
          observedAt: new Date().toISOString(),
          url: "https://github.com/example-org/billing-service/issues/482",
          title: "Subscription webhooks drop customer.subscription.updated events after plan change · Issue #482",
          text:
            "After migrating to Stripe subscriptions, our webhook endpoint stops receiving customer.subscription.updated " +
            "when a customer changes plans. invoice.paid still arrives. We verify the Stripe-Signature header and return 200. " +
            "Need to confirm which subscription lifecycle events to listen for and how to test webhooks locally.",
          truncated: false,
        },
      });
      expect(obs.structuredContent).toMatchObject({ accepted: true });

      const res = await client.callTool(
        {
          name: "rank_site_links",
          arguments: { requestId: "live-1", site: { origin: "https://docs.stripe.com", name: "Stripe Docs" }, candidates: CANDIDATES, maxResults: 3, deadlineMs: 25_000 },
        },
        undefined,
        { timeout: 60_000 },
      );
      const out = RankResponseSchema.parse(res.structuredContent);
      expect(out, JSON.stringify({ status: out.status, reason: "reason" in out ? out.reason : undefined })).toMatchObject({ status: "ok" });
      if (out.status !== "ok") return;
      expect(out.items.length).toBeGreaterThanOrEqual(1);
      for (const item of out.items) {
        expect(CANDIDATES.map((c) => c.id)).toContain(item.id);
        expect(item.evidence.length).toBeGreaterThanOrEqual(1); // only service-validated evidence survives
      }
      expect(out.items.some((i) => i.evidence.some((e) => e.kind === "activity"))).toBe(true);

      const runs = readFileSync(join(home, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const run = runs.at(-1)!;
      expect(run.status).toBe("ok");
      expect(run.toolCalls as number).toBeGreaterThanOrEqual(1);
      expect(run.sourceIds).toContain("activity"); // from the run's audit: read_recent_activity issued evidence
      // The init capability check passed: an ok run requires it, and nothing logged a failure.
      expect(logs.join("\n")).not.toContain("capability check failed");
      console.log(JSON.stringify({ items: out.items.map((i) => i.id), droppedCount: out.droppedCount, ms: run.ms, turns: run.turns, toolCalls: run.toolCalls }));
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }
  });
});
