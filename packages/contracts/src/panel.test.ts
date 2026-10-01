import { describe, expect, it } from "vitest";
import {
  NATIVE_COMMAND_MAX_BYTES,
  NativeCommandSchema,
  PanelStateSchema,
  PREVIEW_CHUNK_MAX_BYTES,
} from "./index.js";

const RES = `res_${"a".repeat(64)}`;
const HASH = "b".repeat(64);

const offer = {
  resourceId: RES,
  version: HASH,
  kind: "skill",
  siteOrigin: "https://docs.example.com",
  sourceUrl: "https://docs.example.com/skills/a.md",
  byteLength: 10,
  fetchedAt: 1,
  resourceRevision: 2,
  skill: { name: "a", description: "d" },
};
const library = {
  resourceId: RES,
  kind: "llms_txt",
  siteOrigin: "https://docs.example.com",
  sourceUrl: "https://docs.example.com/llms.txt",
  defaultVersion: HASH,
  state: "approved",
  versions: [{ hash: HASH, state: "approved", byteLength: 10, fetchedAt: 1 }],
  resourceRevision: 3,
};
const capabilities = {
  type: "capabilities",
  coreInstanceId: "0123456789abcdef0123456789abcdef",
  revision: 1,
  approvalRevision: 4,
  offers: [offer],
  library: [library],
  conflicts: [{ name: "scout-skill-0123456789abcdef", resourceId: RES, code: "left_modified" }],
  origins: [{ origin: "https://docs.example.com", autoAcquire: true, acknowledgedAt: 5, permitted: true }],
  truncated: false,
};
const chunk = {
  type: "preview",
  commandId: "p-1",
  resourceId: RES,
  version: HASH,
  seq: 0,
  offset: 0,
  totalBytes: 3,
  text: "abc",
  sha256: HASH,
  descriptor: { kind: "llms_txt", siteOrigin: "https://docs.example.com", sourceUrl: "https://docs.example.com/llms.txt" },
  nextCursor: "cur_1",
};

describe("panel frames (core -> app)", () => {
  it("parses every new frame", () => {
    const frames = [
      capabilities,
      chunk,
      { type: "ack", commandId: "a1", ok: true, revision: 3, approvalRevision: 9 },
      { type: "ack", commandId: "a1", ok: false, code: "stale_revision", revision: 4 },
      { type: "ack", commandId: "a1", ok: false, code: "unavailable" },
      { type: "audit", entries: [{ at: 1, role: "interactive", method: "current_site", outcome: "ok", origin: "https://docs.example.com" }] },
      { type: "audit", entries: [{ at: 1, role: "job", method: "current_site", outcome: "not_granted" }] },
      { type: "grant", agentBrowserContext: true },
      { type: "state", status: "idle", visitEpoch: 2, detail: "docs.example.com", permitted: true },
    ];
    for (const f of frames) expect(PanelStateSchema.parse(f)).toEqual(f);
  });

  it("names a library entry without a default `no_default`", () => {
    const entry = { ...library, state: "no_default", versions: [{ ...library.versions[0], state: "pending" }] };
    delete (entry as { defaultVersion?: string }).defaultVersion;
    expect(PanelStateSchema.safeParse({ ...capabilities, library: [entry] }).success).toBe(true);
    expect(PanelStateSchema.safeParse({ ...capabilities, library: [{ ...entry, state: "pending_only" }] }).success).toBe(false);
  });

  it("still parses the old frames", () => {
    expect(PanelStateSchema.safeParse({ type: "state", status: "disconnected" }).success).toBe(true);
    expect(PanelStateSchema.safeParse({ type: "results", visitEpoch: 1, status: "empty", items: [] }).success).toBe(true);
  });

  it("rejects bad shapes", () => {
    const bad = [
      { ...capabilities, offers: Array.from({ length: 51 }, () => offer) },
      { ...capabilities, library: [{ ...library, state: "declined" }] },
      { ...capabilities, library: [{ ...library, versions: Array.from({ length: 7 }, () => library.versions[0]) }] },
      { ...capabilities, offers: [{ ...offer, version: "short" }] },
      { ...capabilities, offers: [{ ...offer, siteOrigin: "http://docs.example.com" }] },
      { ...chunk, sha256: "nothex" },
      { ...chunk, seq: -1 },
      { type: "ack", commandId: "a1", ok: true },
      { type: "ack", commandId: "a1", ok: false, code: "boom" },
      { type: "ack", commandId: "has space", ok: true, revision: 0, approvalRevision: 0 },
      { type: "audit", entries: [{ at: 1, role: "admin", method: "current_site", outcome: "ok" }] },
      { type: "audit", entries: [{ at: 1, role: "interactive", method: "current_site", outcome: "made_up" }] },
      { ...capabilities, coreInstanceId: undefined },
      { ...capabilities, coreInstanceId: "" },
      { ...capabilities, coreInstanceId: "x".repeat(65) },
      { ...capabilities, coreInstanceId: "has space" },
      { type: "grant" },
    ];
    for (const f of bad) expect(PanelStateSchema.safeParse(f).success).toBe(false);
  });
});

describe("native commands (app -> core)", () => {
  const commands = [
    { type: "preview", commandId: "c1", resourceId: RES, version: HASH },
    { type: "preview", commandId: "c1", resourceId: RES, version: HASH, cursor: "abc_DEF-1" },
    { type: "approve", commandId: "c2", resourceId: RES, version: HASH, expectedRevision: 3 },
    { type: "decline", commandId: "c3", resourceId: RES, version: HASH, expectedRevision: 3 },
    { type: "revoke", commandId: "c4", resourceId: RES, expectedRevision: 3 },
    { type: "set_auto_acquire", commandId: "c5", origin: "https://docs.example.com", enabled: true, expectedEnabled: false, acknowledgeRisk: true },
    { type: "set_agent_browser_context", commandId: "c6", enabled: false, expectedEnabled: true },
    { type: "refresh_capabilities", commandId: "c7" },
  ];

  it("parses every new command", () => {
    for (const c of commands) expect(NativeCommandSchema.parse(c)).toEqual(c);
  });

  it("rejects missing or malformed IDs, bodies, and extra fields", () => {
    const bad = [
      { type: "approve", resourceId: RES, version: HASH, expectedRevision: 3 },
      { type: "approve", commandId: "", resourceId: RES, version: HASH, expectedRevision: 3 },
      { type: "approve", commandId: "x".repeat(65), resourceId: RES, version: HASH, expectedRevision: 3 },
      { type: "approve", commandId: "a/b", resourceId: RES, version: HASH, expectedRevision: 3 },
      { type: "approve", commandId: "c", resourceId: "res_x", version: HASH, expectedRevision: 3 },
      { type: "approve", commandId: "c", resourceId: RES, version: HASH, expectedRevision: -1 },
      { type: "approve", commandId: "c", resourceId: RES, version: HASH, expectedRevision: 1, text: "resource body" },
      { type: "revoke", commandId: "c", resourceId: RES },
      { type: "set_auto_acquire", commandId: "c", origin: "https://x.example/path", enabled: true, expectedEnabled: false, acknowledgeRisk: true },
      { type: "set_auto_acquire", commandId: "c", origin: "https://x.example", enabled: true, expectedEnabled: false },
      { type: "set_auto_acquire", commandId: "c", origin: "https://x.example", enabled: true, acknowledgeRisk: true },
      { type: "set_agent_browser_context", commandId: "c", enabled: "yes", expectedEnabled: false },
      { type: "set_agent_browser_context", commandId: "c", enabled: true },
      { type: "preview", commandId: "c", resourceId: RES, version: HASH, cursor: "x".repeat(65) },
      { type: "refresh_capabilities", commandId: "c", config: {} },
    ];
    for (const c of bad) expect(NativeCommandSchema.safeParse(c).success).toBe(false);
  });

  it("keeps the largest legal command line under the atomic pipe-write limit", () => {
    const longest = "x".repeat(64);
    // The longest legal origin: 253-character hostname plus a 5-digit port.
    const label = "a".repeat(63);
    const host = `${label}.${label}.${label}.${"a".repeat(61)}`;
    const origin = `https://${host}:65535`;
    const maxInt = Number.MAX_SAFE_INTEGER;
    const largest = [
      { type: "preview", commandId: longest, resourceId: RES, version: HASH, cursor: longest },
      { type: "approve", commandId: longest, resourceId: RES, version: HASH, expectedRevision: maxInt },
      { type: "decline", commandId: longest, resourceId: RES, version: HASH, expectedRevision: maxInt },
      { type: "revoke", commandId: longest, resourceId: RES, expectedRevision: maxInt },
      { type: "set_auto_acquire", commandId: longest, origin, enabled: false, expectedEnabled: false, acknowledgeRisk: false },
      { type: "set_agent_browser_context", commandId: longest, enabled: false, expectedEnabled: false },
      { type: "refresh_capabilities", commandId: longest },
    ];
    for (const c of largest) {
      expect(NativeCommandSchema.safeParse(c).success).toBe(true);
      expect(Buffer.byteLength(`${JSON.stringify(c)}\n`, "utf8")).toBeLessThan(NATIVE_COMMAND_MAX_BYTES);
    }
    expect(NATIVE_COMMAND_MAX_BYTES).toBe(4096);
    expect(PREVIEW_CHUNK_MAX_BYTES).toBe(16 * 1024);
    // A 254-character host is not an origin, so nothing longer gets through.
    expect(NativeCommandSchema.safeParse({ ...largest[4], origin: `https://a${host}` }).success).toBe(false);
  });
});

