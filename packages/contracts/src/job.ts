import { z } from "zod";
import { AgentRequestIdSchema, CoreInstanceIdSchema } from "./agent.js";
import { CandidateSchema } from "./catalog.js";
import { HttpsOriginSchema } from "./capability.js";

// A background recommendation job: what the core hands a fresh agent run, what the model
// may answer, and what the host reports back. The visit is identified by the existing visit
// epoch plus `coreInstanceId`, so a restarted core never mistakes an old job for current.

/** Most picks a job may ask for, and the most the model may return. */
export const JOB_MAX_PICKS = 3;
/** Longest reason the model may write, in characters. */
export const JOB_REASON_MAX_CHARS = 140;
/** The catalog's candidate cap. */
export const JOB_MAX_CANDIDATES = 500;
/** The whole visit budget: discovery, reasoning and target checks. */
export const JOB_MAX_DEADLINE_MS = 30_000;

const RevisionSchema = z.int().nonnegative();
const OpaqueHashSchema = z.string().min(1).max(128);

/** A candidate as the model sees it: no URL, so it can only pick by ID. */
export const JobCandidateSchema = CandidateSchema.pick({ id: true, title: true, description: true, labelQuality: true });

export const JobRequestSchema = z
  .object({
    requestId: AgentRequestIdSchema,
    coreInstanceId: CoreInstanceIdSchema,
    visitEpoch: z.int().nonnegative(),
    origin: HttpsOriginSchema,
    catalogHash: OpaqueHashSchema,
    browserSnapshot: z.object({ id: AgentRequestIdSchema, revision: RevisionSchema }),
    approvalRevision: RevisionSchema,
    grantRevision: RevisionSchema,
    profileFingerprint: OpaqueHashSchema,
    /** Remaining budget for this job when it was created. */
    deadlineMs: z.int().min(1).max(JOB_MAX_DEADLINE_MS),
    candidates: z.array(JobCandidateSchema).min(1).max(JOB_MAX_CANDIDATES),
    maxPicks: z.int().min(1).max(JOB_MAX_PICKS),
  })
  .refine((j) => new Set(j.candidates.map((c) => c.id)).size === j.candidates.length, { message: "duplicate candidate id" });

// ---------- model-facing output ----------

/** A catalog candidate ID ("c" + base36 index), bounded. */
const CANDIDATE_ID_MAX_CHARS = 32;
const CANDIDATE_ID_PATTERN = "^c[0-9a-z]+$";

export const AgentPickSchema = z.strictObject({
  id: z.string().max(CANDIDATE_ID_MAX_CHARS).regex(new RegExp(CANDIDATE_ID_PATTERN)),
  reason: z.string().min(1).max(JOB_REASON_MAX_CHARS),
});

/**
 * The only two shapes the model may return: 1–3 distinct candidate IDs with reasons, or
 * `empty`. No URLs, evidence or status codes: the model cannot declare success for an
 * arbitrary link or invent an operational status. Whether each ID is in the job's
 * candidate list is the host's check, not this schema's.
 */
export const JobAgentOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    items: z
      .array(AgentPickSchema)
      .min(1)
      .max(JOB_MAX_PICKS)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length, { message: "duplicate candidate id" }),
  }),
  z.strictObject({ status: z.literal("empty") }),
]);

/**
 * Plain JSON Schema for the CLI's `--json-schema` flag. The CLI requires a top-level object,
 * so the two shapes are folded into one; JobAgentOutputSchema enforces the split (and
 * distinct IDs, which JSON Schema cannot express for objects) afterwards.
 */
export const JOB_AGENT_OUTPUT_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok", "empty"] },
    items: {
      type: "array",
      minItems: 1,
      maxItems: JOB_MAX_PICKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: {
          id: { type: "string", minLength: 2, maxLength: CANDIDATE_ID_MAX_CHARS, pattern: CANDIDATE_ID_PATTERN },
          reason: { type: "string", minLength: 1, maxLength: JOB_REASON_MAX_CHARS },
        },
      },
    },
  },
} as const);

// ---------- host result ----------

/** Fixed reason codes per non-success status. Only the host produces these. */
export const JOB_CANCELLED_REASONS = ["superseded", "visit_changed", "revoked", "paused", "shutdown"] as const;
export const JOB_UNAVAILABLE_REASONS = ["no_time_left", "agent_unavailable", "busy"] as const;
export const JOB_ERROR_REASONS = [
  "timeout",
  "invalid_output",
  "tool_unavailable",
  "preflight_failed",
  "unsupported_configuration",
  "agent_failed",
] as const;

const jobIdentity = {
  requestId: AgentRequestIdSchema,
  coreInstanceId: CoreInstanceIdSchema,
  visitEpoch: z.int().nonnegative(),
};

/**
 * What the host reports for a job. Tool-use names and optional-tool availability are local
 * job details, never part of this result.
 */
export const HostJobResultSchema = z.discriminatedUnion("status", [
  z.object({ ...jobIdentity, status: z.literal("ok"), items: JobAgentOutputSchema.options[0].shape.items }),
  z.object({ ...jobIdentity, status: z.literal("empty") }),
  z.object({ ...jobIdentity, status: z.literal("cancelled"), reason: z.enum(JOB_CANCELLED_REASONS) }),
  z.object({ ...jobIdentity, status: z.literal("unavailable"), reason: z.enum(JOB_UNAVAILABLE_REASONS) }),
  z.object({ ...jobIdentity, status: z.literal("error"), reason: z.enum(JOB_ERROR_REASONS) }),
]);

export type JobCandidate = z.infer<typeof JobCandidateSchema>;
export type JobRequest = z.infer<typeof JobRequestSchema>;
export type AgentPick = z.infer<typeof AgentPickSchema>;
export type JobAgentOutput = z.infer<typeof JobAgentOutputSchema>;
export type HostJobResult = z.infer<typeof HostJobResultSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
