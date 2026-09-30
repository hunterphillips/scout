// Public tool contracts for the personal-context service. Clients (Scout, `pcm`, anything
// else) import these schemas and types; this module depends on zod only.

import { z } from "zod";

/** Candidates per rank request, at most. */
export const MAX_CANDIDATES = 500;
/** Upper bound on `deadlineMs`, and on the service's own `maxRankMs`. */
export const MAX_DEADLINE_MS = 26_000;
/** Longest reason the model may write, in characters. */
export const MAX_REASON_CHARS = 140;
/** Most picks a request may ask for, and the most the model may return. */
export const MAX_RESULTS = 3;
/** Evidence ids the model may cite per item. */
export const MAX_EVIDENCE_PER_ITEM = 8;
/** An evidence id as the source tools issue it: `e1`, `e2`, ... (never `e0`). */
export const EVIDENCE_ID_PATTERN = /^e[1-9][0-9]*$/;

// ---------- rank_site_links input ----------

export const RankCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  labelQuality: z.string(),
});

export const RankRequestSchema = z.object({
  requestId: z.string().min(1),
  site: z.object({
    origin: z.string().min(1),
    name: z.string().optional(),
  }),
  candidates: z.array(RankCandidateSchema).max(MAX_CANDIDATES),
  maxResults: z.int().min(1).max(MAX_RESULTS),
  /** The caller's remaining budget for the model run. */
  deadlineMs: z.int().min(1).max(MAX_DEADLINE_MS),
  /** A requestId from the same MCP session to cancel first; ignored otherwise. */
  supersedes: z.string().min(1).optional(),
});

export type RankCandidate = z.infer<typeof RankCandidateSchema>;
export type RankRequest = z.infer<typeof RankRequestSchema>;

// ---------- model-facing output (--json-schema) ----------

export const AgentItemSchema = z.strictObject({
  id: z.string().min(1),
  reason: z.string().min(1).max(MAX_REASON_CHARS),
  /** Exactly as the source tools returned them. */
  evidenceIds: z.array(z.string().regex(EVIDENCE_ID_PATTERN)).min(1).max(MAX_EVIDENCE_PER_ITEM),
});

/** The only two shapes the model may return. The service re-validates; the CLI's own check is not trusted alone. */
export const AgentOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), items: z.array(AgentItemSchema).min(1).max(MAX_RESULTS) }),
  z.strictObject({ status: z.literal("empty") }),
]);

export type AgentItem = z.infer<typeof AgentItemSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/**
 * Plain JSON Schema for the CLI's `--json-schema` flag. The CLI requires a top-level object,
 * so the two shapes are folded into one; AgentOutputSchema enforces the split afterwards.
 * Equivalent to the Phase 0 spike's AGENT_OUTPUT_SCHEMA, with the evidence pattern
 * tightened to the ids the tools actually issue (`e1` onward).
 */
export const AGENT_OUTPUT_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok", "empty"] },
    items: {
      type: "array",
      maxItems: MAX_RESULTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason", "evidenceIds"],
        properties: {
          id: { type: "string" },
          reason: { type: "string", maxLength: MAX_REASON_CHARS },
          evidenceIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_EVIDENCE_PER_ITEM,
            items: { type: "string", pattern: EVIDENCE_ID_PATTERN.source },
          },
        },
      },
    },
  },
} as const);

// ---------- context_status output ----------

export const ContextStatusSchema = z.object({
  /** Random per service process start. */
  serviceInstanceId: z.string().min(1),
  /** Bumps on each accepted observation or expiry. */
  activityRevision: z.int().nonnegative(),
  /** Hash of the enabled source config. */
  sourceGrantRevision: z.string().min(1),
});

export type ContextStatus = z.infer<typeof ContextStatusSchema>;

// ---------- rank_site_links output ----------

export const EvidenceSchema = z.object({
  id: z.string().regex(EVIDENCE_ID_PATTERN),
  kind: z.enum(["activity", "note", "focus"]),
  /** Written by the service from its audit map; never supplied by the model. */
  label: z.string(),
});

export const RankItemSchema = z.object({
  id: z.string().min(1),
  reason: z.string().max(MAX_REASON_CHARS),
  evidence: z.array(EvidenceSchema).min(1),
});

export const RankOkSchema = z.object({
  status: z.literal("ok"),
  items: z.array(RankItemSchema).min(1).max(MAX_RESULTS),
  droppedCount: z.int().nonnegative(),
  ...ContextStatusSchema.shape,
});

export const RankEmptySchema = z.object({
  status: z.literal("empty"),
  ...ContextStatusSchema.shape,
});

/** Only the service produces these three statuses; the model cannot. */
export const RankFailureSchema = z.object({
  status: z.enum(["unavailable", "cancelled", "error"]),
  reason: z.string(),
  droppedCount: z.int().nonnegative().optional(),
  ...ContextStatusSchema.shape,
});

/** Every variant carries the three ContextStatus fields. */
export const RankResponseSchema = z.union([RankOkSchema, RankEmptySchema, RankFailureSchema]);

export type Evidence = z.infer<typeof EvidenceSchema>;
export type RankItem = z.infer<typeof RankItemSchema>;
export type RankResponse = z.infer<typeof RankResponseSchema>;

// ---------- observe_activity ----------

export const ActivityObservationSchema = z.object({
  sensor: z.string().min(1),
  kind: z.literal("viewed_page"),
  observedAt: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  /** Any length is accepted here; the observation store truncates to 8 KiB. */
  text: z.string().optional(),
  truncated: z.boolean(),
});

export const ObserveActivityResultSchema = z.object({
  accepted: z.boolean(),
  observationId: z.string(),
});

export type ActivityObservation = z.infer<typeof ActivityObservationSchema>;
export type ObserveActivityResult = z.infer<typeof ObserveActivityResultSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
