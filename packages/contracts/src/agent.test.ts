import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_STATUS_CODES,
  AgentRequestSchema,
  agentResponseSchema,
  deriveResourceId,
  HostJobResultSchema,
  HttpsOriginSchema,
  isHttpsOrigin,
  JOB_AGENT_OUTPUT_JSON_SCHEMA,
  JobAgentOutputSchema,
  JobRequestSchema,
  ResourceSchema,
} from "./index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const req = (method: string, params: unknown) => ({ protocol: AGENT_PROTOCOL_VERSION, requestId: "r1", method, params });

describe("isHttpsOrigin", () => {
  it.each([
    "https://example.com",
    "https://docs.example.com",
    "https://a-b.example.co.uk",
    "https://xn--bcher-kva.example",
    "https://localhost",
    "https://example.com:8443",
    "https://example.com:1",
    "https://example.com:65535",
    "https://a1.b2",
    `https://${"a".repeat(63)}.com`,
  ])("accepts %s", (v) => {
    expect(isHttpsOrigin(v)).toBe(true);
    expect(HttpsOriginSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    ["http scheme", "http://example.com"],
    ["uppercase host", "https://Example.com"],
    ["trailing dot", "https://example.com."],
    ["empty label", "https://a..example.com"],
    ["leading hyphen", "https://-a.example.com"],
    ["trailing hyphen in label", "https://a-.example.com"],
    ["underscore", "https://a_b.example.com"],
    ["quote", 'https://a"b.example.com'],
    ["backtick", "https://a`b.example.com"],
    ["brace", "https://a${b}.example.com"],
    ["percent", "https://a%41.example.com"],
    ["unicode", "https://b\u00fccher.example"],
    ["userinfo", "https://user@example.com"],
    ["empty userinfo", "https://@example.com"],
    ["path", "https://example.com/"],
    ["query", "https://example.com?x"],
    ["fragment", "https://example.com#x"],
    ["default port", "https://example.com:443"],
    ["port 0", "https://example.com:0"],
    ["port too large", "https://example.com:65536"],
    ["port leading zero", "https://example.com:08443"],
    ["empty port", "https://example.com:"],
    ["ipv4", "https://127.0.0.1"],
    ["numeric last label", "https://example.123"],
    ["hex ipv4", "https://0x7f.1"],
    ["ipv6", "https://[::1]"],
    ["label too long", `https://${"a".repeat(64)}.com`],
    ["host too long", `https://${Array(64).fill("abc").join(".")}`],
    ["whitespace", "https://exa mple.com"],
    ["newline", "https://example.com\nx"],
  ])("refuses %s", (_label, v) => {
    expect(isHttpsOrigin(v)).toBe(false);
    expect(HttpsOriginSchema.safeParse(v).success).toBe(false);
  });
});

describe("capability contracts", () => {
  it("derives the resource id from full SHA-256 of kind and canonical URL", async () => {
    const url = "https://docs.example.com/llms.txt";
    const expected = "res_" + createHash("sha256").update(`llms_txt\n${url}`).digest("hex");
    expect(await deriveResourceId("llms_txt", url)).toBe(expected);
    expect(await deriveResourceId("skill", url)).not.toBe(expected);
  });

  it("refuses to derive an id from a non-canonical URL", async () => {
    for (const bad of ["https://Docs.example.com/a", "https://x.com/a#f", "http://x.com/a", "https://u:p@x.com/a", "https://x.com/a/../b"]) {
      await expect(deriveResourceId("skill", bad)).rejects.toThrow();
    }
  });

  it("ties decisions, default version and blocked state together", async () => {
    const sourceUrl = "https://cdn.example.net/skills/a.md";
    const version = { hash: HASH_A, blobRef: HASH_A, byteLength: 10, fetchedAt: 1, state: "approved", decision: { actor: "user", at: 2 } };
    const r = {
      id: await deriveResourceId("skill", sourceUrl),
      kind: "skill",
      siteOrigin: "https://example.com",
      publisherOrigin: "https://cdn.example.net",
      sourceUrl,
      versions: [version, { hash: HASH_B, blobRef: HASH_B, byteLength: 5, fetchedAt: 3, state: "pending" }],
      defaultVersion: HASH_A,
      blocked: false,
    };
    expect(ResourceSchema.safeParse(r).success).toBe(true);
    expect(ResourceSchema.safeParse({ ...r, defaultVersion: HASH_B }).success).toBe(false); // pending is never a default
    expect(ResourceSchema.safeParse({ ...r, blocked: true }).success).toBe(false);
    expect(ResourceSchema.safeParse({ ...r, publisherOrigin: "https://example.com" }).success).toBe(false);
    expect(ResourceSchema.safeParse({ ...r, versions: [{ ...version, decision: undefined }] }).success).toBe(false);
    expect(ResourceSchema.safeParse({ ...r, kind: "mcp_server" }).success).toBe(false);
  });
});

describe("agent protocol", () => {
  it("accepts the read-only methods with bounded params", () => {
    expect(AgentRequestSchema.safeParse(req("hello", { token: "t0k" })).success).toBe(true);
    expect(AgentRequestSchema.safeParse(req("current_site", {})).success).toBe(true);
    expect(AgentRequestSchema.safeParse(req("recent_activity", { limit: 10 })).success).toBe(true);
    expect(AgentRequestSchema.safeParse(req("read_resource", { resourceId: "res_" + HASH_A, cursor: "abc_-1" })).success).toBe(true);
    expect(AgentRequestSchema.safeParse(req("recent_activity", { limit: 11 })).success).toBe(false);
    expect(AgentRequestSchema.safeParse(req("site_links", { cursor: "x".repeat(129) })).success).toBe(false);
    expect(AgentRequestSchema.safeParse(req("site_links", { cursor: "../etc" })).success).toBe(false);
    expect(AgentRequestSchema.safeParse(req("current_site", { url: "https://x.com" })).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ ...req("current_site", {}), requestId: "x".repeat(65) }).success).toBe(false);
  });

  it("has no mutation methods", () => {
    for (const m of ["approve_resource", "revoke_resource", "set_grant", "open_link", "decline"]) {
      expect(AgentRequestSchema.safeParse(req(m, {})).success).toBe(false);
    }
  });

  it("checks responses against the method's result and the closed status set", () => {
    const schema = agentResponseSchema("current_site");
    const base = { protocol: 1, requestId: "r1", coreInstanceId: "core1" };
    expect(schema.safeParse({ ...base, status: "ok", result: { site: null } }).success).toBe(true);
    expect(schema.safeParse({ ...base, status: "ok", result: { resources: [] } }).success).toBe(false);
    for (const code of AGENT_STATUS_CODES) {
      expect(schema.safeParse({ ...base, status: "error", error: { code, message: "m" } }).success).toBe(true);
    }
    expect(schema.safeParse({ ...base, status: "error", error: { code: "denied", message: "m" } }).success).toBe(false);
    expect(schema.safeParse({ ...base, coreInstanceId: undefined, status: "ok", result: { site: null } }).success).toBe(false);
  });

  it("caps read_resource chunks in UTF-8 bytes", () => {
    const schema = agentResponseSchema("read_resource");
    const result = {
      resourceId: "res_" + HASH_A, kind: "llms_txt", siteOrigin: "https://x.com", publisherOrigin: "https://x.com",
      sourceUrl: "https://x.com/llms.txt", version: HASH_A, approval: "approved", offset: 0, totalBytes: 20_000,
    };
    const ok = (text: string) => ({ protocol: 1, requestId: "r", coreInstanceId: "c", status: "ok", result: { ...result, text } });
    expect(schema.safeParse(ok("é".repeat(8 * 1024))).success).toBe(true);
    expect(schema.safeParse(ok("é".repeat(8 * 1024 + 1))).success).toBe(false);
  });
});

describe("job contracts", () => {
  const job = {
    requestId: "j1", coreInstanceId: "core1", visitEpoch: 4, origin: "https://docs.stripe.com", catalogHash: "cat1",
    browserSnapshot: { id: "s1", revision: 2 }, approvalRevision: 0, grantRevision: 1, profileFingerprint: "p1",
    deadlineMs: 26_000, candidates: [{ id: "c0", title: "Billing", labelQuality: "published" }], maxPicks: 3,
  };

  it("accepts a job request and rejects duplicate candidates, an over-long candidate id or a long deadline", () => {
    expect(JobRequestSchema.safeParse(job).success).toBe(true);
    expect(JobRequestSchema.safeParse({ ...job, candidates: [job.candidates[0], job.candidates[0]] }).success).toBe(false);
    expect(JobRequestSchema.safeParse({ ...job, candidates: [{ ...job.candidates[0], id: `c${"0".repeat(32)}` }] }).success).toBe(false);
    expect(JobRequestSchema.safeParse({ ...job, deadlineMs: 30_001 }).success).toBe(false);
    expect(JobRequestSchema.safeParse({ ...job, origin: "https://x.com/path" }).success).toBe(false);
  });

  it("lets the model say only ok (1-3 distinct ids, short reasons) or empty", () => {
    const pick = (id: string) => ({ id, reason: "fits the billing issue" });
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [pick("c0"), pick("c1")] }).success).toBe(true);
    expect(JobAgentOutputSchema.safeParse({ status: "empty" }).success).toBe(true);
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [] }).success).toBe(false);
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [pick("c0"), pick("c0")] }).success).toBe(false);
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: ["a", "b", "c", "d"].map(pick) }).success).toBe(false);
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [{ id: "c0", reason: "x".repeat(141) }] }).success).toBe(false);
    expect(JobAgentOutputSchema.safeParse({ status: "empty", items: [] }).success).toBe(false);
    expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [{ ...pick("c0"), url: "https://evil" }] }).success).toBe(false);
    for (const id of ["a", "c", "C0", "c0/../x", "https://evil", `c${"0".repeat(32)}`]) {
      expect(JobAgentOutputSchema.safeParse({ status: "ok", items: [pick(id)] }).success).toBe(false);
    }
    for (const status of ["error", "unavailable", "cancelled"]) {
      expect(JobAgentOutputSchema.safeParse({ status }).success).toBe(false);
    }
  });

  it("exports a frozen JSON schema with no evidence or source fields", () => {
    expect(Object.isFrozen(JOB_AGENT_OUTPUT_JSON_SCHEMA.properties.items.items)).toBe(true);
    expect(Object.keys(JOB_AGENT_OUTPUT_JSON_SCHEMA.properties.items.items.properties).sort()).toEqual(["id", "reason"]);
  });

  it("gives every non-success host result a fixed reason code", () => {
    const id = { requestId: "j1", coreInstanceId: "core1", visitEpoch: 4 };
    expect(HostJobResultSchema.safeParse({ ...id, status: "error", reason: "invalid_output" }).success).toBe(true);
    expect(HostJobResultSchema.safeParse({ ...id, status: "cancelled", reason: "visit_changed" }).success).toBe(true);
    expect(HostJobResultSchema.safeParse({ ...id, status: "error", reason: "model said so" }).success).toBe(false);
    expect(HostJobResultSchema.safeParse({ ...id, status: "ok", items: [{ id: "c0", reason: "r" }] }).success).toBe(true);
  });
});
