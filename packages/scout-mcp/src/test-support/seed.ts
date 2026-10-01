// Synthetic fixture data shared by the scout-mcp tests. Nothing here is real browsing.

import { AGENT_PROTOCOL_VERSION, type AgentMethod, type AgentParams, type AgentRequestOf } from "@scout/contracts";
import type { FixtureSeed } from "../fixture.js";

export const SITE = "https://docs.example.com";
export const LLMS_URL = `${SITE}/llms.txt`;
export const SKILL_URL = "https://cdn.example.net/skills/billing.md";
export const AGENTS_URL = `${SITE}/AGENTS.md`;
export const PENDING_URL = `${SITE}/skills/pending.md`;
export const DECLINED_URL = `${SITE}/skills/declined.md`;

/** 40 KiB-ish of mixed 1-, 2-, 3- and 4-byte characters, so chunk cuts land mid-character. */
export const LONG_TEXT = Array.from({ length: 2000 }, (_, i) => `line ${i}: café ✓ 😀\n`).join("");

export function seed(overrides: Partial<FixtureSeed> = {}): FixtureSeed {
  return {
    coreInstanceId: "core-a",
    token: "fixture-token",
    browserContextGranted: true,
    currentSite: { origin: SITE, url: `${SITE}/billing`, title: "Billing docs", visitEpoch: 7 },
    activity: [
      { origin: SITE, url: `${SITE}/billing`, observedAt: 2, title: "Billing docs", text: "How invoices work", textTruncated: false },
      { origin: "https://github.com", url: "https://github.com/o/r/issues/1", observedAt: 1, title: "Issue 1", textTruncated: false },
    ],
    siteLinks: {
      origin: SITE,
      catalogVersion: "cat-1",
      links: Array.from({ length: 30 }, (_, i) => ({ id: `c${i.toString(36)}`, href: `${SITE}/p${i}`, title: `Page ${i}` })),
    },
    resources: [
      { kind: "llms_txt", siteOrigin: SITE, sourceUrl: LLMS_URL, versions: [{ text: "old guide", state: "superseded" }, { text: LONG_TEXT, state: "approved" }] },
      { kind: "skill", siteOrigin: SITE, sourceUrl: SKILL_URL, versions: [{ text: "billing skill", state: "approved" }] },
      { kind: "agents_md", siteOrigin: "https://other.example.org", sourceUrl: "https://other.example.org/AGENTS.md", versions: [{ text: "other", state: "approved" }] },
      { kind: "skill", siteOrigin: SITE, sourceUrl: PENDING_URL, versions: [{ text: "not yet approved", state: "pending" }] },
      { kind: "skill", siteOrigin: SITE, sourceUrl: DECLINED_URL, versions: [{ text: "declined", state: "declined" }] },
    ],
    ...overrides,
  };
}

let seq = 0;
export function req<M extends AgentMethod>(method: M, params: AgentParams<M>): AgentRequestOf<M> {
  return { protocol: AGENT_PROTOCOL_VERSION, requestId: `t${++seq}`, method, params } as AgentRequestOf<M>;
}
