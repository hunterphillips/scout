// The JSONL link between the native app and the core (stdio): what the core shows the user
// and the commands the app sends back. Browser-safe like the rest of the root export.
//
// Core -> app frames are discriminated by `type`; two types carry a second discriminator the
// Swift decoder reads: `results` by `status`, `ack` by `ok`.
//
// Results: a `results` frame names the core instance, visit, origin, and job it answers and
// never carries a URL. A `state` frame resets the window's results for the visit it names (a
// new `visitEpoch`, `paused`, `disconnected`, or `idle` for the same visit when the core
// cleared them); `working` with a `jobId` starts a new job's spinner. So the core sends
// `working{jobId}` and then the visit's `idle` before it publishes a job's results, never
// after: a later `idle` for the same visit (a re-sent state included) wipes them.
//
// App -> core commands must each fit in one atomic pipe write (NATIVE_COMMAND_MAX_BYTES, the
// platform's PIPE_BUF): the app drops a larger write rather than splitting it. So commands
// carry IDs, hashes, revisions, cursors, and host origins only; never resource text or tool
// configuration.
// Every new command carries a `commandId`; the core answers each one with exactly one `ack`
// (a successful `preview` answers with a `preview` chunk instead). A retried `commandId`
// whose effect already applied gets the same `ok: true` ack and changes nothing.

import { z } from "zod";
import { AGENT_METHODS, AGENT_STATUS_CODES, AgentRequestIdSchema, CoreInstanceIdSchema } from "./agent.js";
import {
  ContentHashSchema,
  HOSTNAME_MAX_CHARS,
  HttpsOriginSchema,
  ResourceIdSchema,
  ResourceKindSchema,
  ResourceVersionStateSchema,
  SOURCE_URL_MAX_CHARS,
  SourceUrlSchema,
  isHttpsOrigin,
} from "./capability.js";
import { CANDIDATE_ID_MAX_CHARS, CANDIDATE_TITLE_MAX } from "./catalog.js";
import { JOB_CANCELLED_REASONS, JOB_ERROR_REASONS, JOB_MAX_PICKS, JOB_REASON_MAX_CHARS, JOB_UNAVAILABLE_REASONS } from "./job.js";

/**
 * PIPE_BUF on macOS (`sys/syslimits.h`), the largest write a pipe takes whole or not at all:
 * one JSONL command line, newline included, must be shorter than this.
 */
export const NATIVE_COMMAND_MAX_BYTES = 512;
/** `https://` + an RFC 1123 hostname of at most HOSTNAME_MAX_CHARS + `:65535`. */
export const HOST_ORIGIN_MAX_CHARS = "https://".length + HOSTNAME_MAX_CHARS + ":65535".length;
/** Text bytes in one `preview` chunk; chunks never split a UTF-8 code point. */
export const PREVIEW_CHUNK_MAX_BYTES = 16 * 1024;
/** How long a preview cursor stays usable. */
export const PREVIEW_CURSOR_TTL_MS = 5 * 60 * 1000;
export const CAPABILITY_OFFERS_MAX = 50;
export const CAPABILITY_LIBRARY_MAX = 200;
export const CAPABILITY_ORIGINS_MAX = 200;
export const CAPABILITY_CONFLICTS_MAX = 50;
/** Versions listed per library entry, newest first; the default version is always among them. */
export const LIBRARY_VERSIONS_MAX = 6;
/**
 * Serialized `capabilities` frame (JSON, newline excluded) stays under this, well inside the
 * app's 1 MiB line limit: the core drops the least recent library entries, then the oldest
 * offers, until it fits, and sets `truncated`.
 */
export const CAPABILITIES_FRAME_MAX_BYTES = 512 * 1024;
export const PANEL_AUDIT_MAX = 200;

const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CommandIdSchema = z.string().regex(COMMAND_ID_RE);
/** Opaque, issued by the core. */
export const PreviewCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Revision = z.int().nonnegative();
/**
 * An origin a command may carry: exactly what isHttpsOrigin accepts (the same check the core
 * applies to every visit, permission, and setting origin), so at most HOST_ORIGIN_MAX_CHARS
 * ASCII characters and the command stays under NATIVE_COMMAND_MAX_BYTES.
 */
export const HostOriginSchema = z.string().max(HOST_ORIGIN_MAX_CHARS).refine(isHttpsOrigin, { message: "not an https host origin" });

// --- Core -> native app ---

export const PanelStatusStateSchema = z
  .object({
    type: z.literal("state"),
    status: z.enum(["idle", "working", "paused", "disconnected"]),
    visitEpoch: z.int().nonnegative().optional(),
    detail: z.string().optional(),
    /** On `idle`: whether a visit to a Chrome-permitted origin is current. Absent on other statuses. */
    permitted: z.boolean().optional(),
    /** On `working` only: the recommendation job the window's spinner belongs to. */
    jobId: AgentRequestIdSchema.optional(),
  })
  .refine((s) => s.jobId === undefined || s.status === "working", { message: "jobId only on working" });

/** A catalog candidate ID as the window echoes it back in `open_link`. */
export const PanelCandidateIdSchema = z.string().max(CANDIDATE_ID_MAX_CHARS).regex(/^c[0-9a-z]+$/);

/**
 * One recommended link as the window shows it. Never the URL: a click sends the candidate ID
 * back (`open_link`) and the core answers with the target it re-checked. `hostname` is the
 * verified target's host, for display. `reason` is shown only in Scout's window, never logged.
 */
export const PanelResultItemSchema = z.strictObject({
  candidateId: PanelCandidateIdSchema,
  title: z.string().min(1).max(CANDIDATE_TITLE_MAX),
  reason: z.string().min(1).max(JOB_REASON_MAX_CHARS),
  hostname: z.string().min(1).max(HOSTNAME_MAX_CHARS),
});

/**
 * What a `results` frame names: this core start, the visit, its origin, and the job that
 * produced it. The window ignores a frame whose instance or visit is not the one it shows.
 */
const resultsIdentity = {
  type: z.literal("results"),
  coreInstanceId: CoreInstanceIdSchema,
  visitEpoch: z.int().nonnegative(),
  origin: HostOriginSchema,
  jobId: AgentRequestIdSchema,
};

// Strict: a results frame that carries anything else (an href above all) is not a results frame.
export const PanelResultsOkSchema = z.strictObject({
  ...resultsIdentity,
  status: z.literal("ok"),
  items: z
    .array(PanelResultItemSchema)
    .min(1)
    .max(JOB_MAX_PICKS)
    .refine((items) => new Set(items.map((i) => i.candidateId)).size === items.length, { message: "duplicate candidate id" }),
});
/** The model's intentional "nothing relevant": a success, never a stand-in for a failure. */
export const PanelResultsEmptySchema = z.strictObject({ ...resultsIdentity, status: z.literal("empty") });
export const PanelResultsUnavailableSchema = z.strictObject({ ...resultsIdentity, status: z.literal("unavailable"), reason: z.enum(JOB_UNAVAILABLE_REASONS) });
/** `reason: "timeout"` is the visit deadline; the window shows it as its own state. */
export const PanelResultsErrorSchema = z.strictObject({ ...resultsIdentity, status: z.literal("error"), reason: z.enum(JOB_ERROR_REASONS) });
export const PanelResultsCancelledSchema = z.strictObject({ ...resultsIdentity, status: z.literal("cancelled"), reason: z.enum(JOB_CANCELLED_REASONS) });

export const SkillDescriptorSchema = z.object({ name: z.string(), description: z.string().optional() });

/**
 * The newest recorded version of an unblocked resource whose site origin Chrome currently
 * permits, while that version is pending. One offer per resource at most.
 */
export const CapabilityOfferSchema = z.object({
  resourceId: ResourceIdSchema,
  /** The version's content hash; approve/decline name it. */
  version: ContentHashSchema,
  kind: ResourceKindSchema,
  siteOrigin: HttpsOriginSchema,
  sourceUrl: SourceUrlSchema,
  byteLength: z.int().nonnegative(),
  fetchedAt: z.number(),
  /** The resource's revision; approve/decline send it back as `expectedRevision`. */
  resourceRevision: Revision,
  skill: SkillDescriptorSchema.optional(),
});

export const LibraryVersionSchema = z.object({
  hash: ContentHashSchema,
  state: ResourceVersionStateSchema,
  byteLength: z.int().nonnegative(),
  fetchedAt: z.number(),
});

export const LibraryEntrySchema = z.object({
  resourceId: ResourceIdSchema,
  kind: ResourceKindSchema,
  siteOrigin: HttpsOriginSchema,
  sourceUrl: SourceUrlSchema,
  defaultVersion: ContentHashSchema.optional(),
  /** `blocked`: revoked; `approved`: has a default version; `no_default`: neither (only pending or declined versions). */
  state: z.enum(["approved", "blocked", "no_default"]),
  /** Newest first, at most LIBRARY_VERSIONS_MAX; includes `defaultVersion` even when older than the rest. */
  versions: z.array(LibraryVersionSchema).max(LIBRARY_VERSIONS_MAX),
  resourceRevision: Revision,
});

/** A skill wrapper the exporter left alone (see scout-core capabilities/exports.ts). */
export const CapabilityConflictSchema = z.object({
  name: z.string(),
  resourceId: ResourceIdSchema,
  code: z.enum(["foreign_collision", "left_modified", "left_symlink", "name_collision", "io_error"]),
});

export const OriginSettingSchema = z.object({
  /** Echoed back in `set_auto_acquire`. */
  origin: HostOriginSchema,
  autoAcquire: z.boolean(),
  /** When the user acknowledged the auto-acquire risk; present only while auto-acquire is on. */
  acknowledgedAt: z.number().optional(),
  /** Chrome currently grants this origin. Auto-acquire acts only while it does. */
  permitted: z.boolean(),
});

/** The whole capability view, re-sent on every change. */
export const PanelCapabilitiesSchema = z.object({
  type: z.literal("capabilities"),
  /**
   * Drawn once per core start (the same id agent.sock replies carry), at most
   * CORE_INSTANCE_ID_MAX_CHARS. `revision` restarts at 1 under a new id: the app resets its
   * high-water mark when the id changes.
   */
  coreInstanceId: CoreInstanceIdSchema,
  /** Increases with every frame sent under one `coreInstanceId`; a lower one under the same id is stale. */
  revision: Revision,
  /** The store's approval revision at the time of the frame. */
  approvalRevision: Revision,
  offers: z.array(CapabilityOfferSchema).max(CAPABILITY_OFFERS_MAX),
  library: z.array(LibraryEntrySchema).max(CAPABILITY_LIBRARY_MAX),
  conflicts: z.array(CapabilityConflictSchema).max(CAPABILITY_CONFLICTS_MAX),
  origins: z.array(OriginSettingSchema).max(CAPABILITY_ORIGINS_MAX),
  /** Some list was cut to its bound, or to CAPABILITIES_FRAME_MAX_BYTES. */
  truncated: z.boolean(),
});

/** What the preview shows beside the text; part of the version's content hash. */
export const PreviewDescriptorSchema = z.object({
  kind: ResourceKindSchema,
  siteOrigin: HttpsOriginSchema,
  sourceUrl: SourceUrlSchema,
  contentType: z.string().optional(),
  skill: SkillDescriptorSchema.optional(),
});

/** One chunk of one version's text, answering a `preview` command. */
export const PanelPreviewChunkSchema = z.object({
  type: z.literal("preview"),
  commandId: CommandIdSchema,
  resourceId: ResourceIdSchema,
  version: ContentHashSchema,
  /** 0 for the first chunk, then +1 per chunk of the same read. */
  seq: z.int().nonnegative(),
  /** Byte offset of `text` in the blob. */
  offset: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  text: z.string(),
  /** SHA-256 (lowercase hex) of the full blob; the same in every chunk. */
  sha256: ContentHashSchema,
  descriptor: PreviewDescriptorSchema,
  /** Send `preview` with this cursor for the next chunk; absent on the last chunk. */
  nextCursor: PreviewCursorSchema.optional(),
});

export const ACK_FAILURE_CODES = ["stale_revision", "not_found", "invalid", "store_error", "not_permitted", "unavailable"] as const;
export const AckFailureCodeSchema = z.enum(ACK_FAILURE_CODES);

export const PanelAckOkSchema = z.object({
  type: z.literal("ack"),
  commandId: CommandIdSchema,
  ok: z.literal(true),
  /** The resource's revision after the command; 0 for commands not about one resource. */
  revision: Revision,
  approvalRevision: Revision,
  /**
   * `open_link` only: the target the core re-checked for the clicked candidate. The app checks
   * it again (https, no credentials or port, the result's host) before opening it.
   */
  target: z.strictObject({ href: z.string().min(1).max(SOURCE_URL_MAX_CHARS) }).optional(),
});

export const PanelAckFailureSchema = z.object({
  type: z.literal("ack"),
  commandId: CommandIdSchema,
  ok: z.literal(false),
  code: AckFailureCodeSchema,
  /** The resource's current revision, when the command named a known resource. */
  revision: Revision.optional(),
});

export const AuditEntrySchema = z.object({
  at: z.number(),
  role: z.enum(["interactive", "job"]),
  method: z.enum(AGENT_METHODS),
  /** `ok` or an agent status code. */
  outcome: z.enum([...AGENT_STATUS_CODES, "ok"]),
  origin: z.string().optional(),
});

/** Recent browser-context reads by the user's agent, oldest first. Never the text read. */
export const PanelAuditSchema = z.object({
  type: z.literal("audit"),
  entries: z.array(AuditEntrySchema).max(PANEL_AUDIT_MAX),
});

/** Most `destinations` one `grant` frame carries. */
export const GRANT_DESTINATIONS_MAX = 64;

/**
 * Whether the user's interactive agent may read browser context, and (optional, P4.3) the
 * sites with background recommendations on: `config.json` `destinations` as `https://<host>`
 * origins, for the side panel's Sites section. Absent from older cores; the Swift app ignores it.
 */
export const PanelGrantSchema = z.object({
  type: z.literal("grant"),
  agentBrowserContext: z.boolean(),
  destinations: z.array(HostOriginSchema).max(GRANT_DESTINATIONS_MAX).optional(),
});

export const PanelResultsSchema = z.discriminatedUnion("status", [
  PanelResultsOkSchema,
  PanelResultsEmptySchema,
  PanelResultsUnavailableSchema,
  PanelResultsErrorSchema,
  PanelResultsCancelledSchema,
]);

// Five members share type "results" (by `status`) and two share "ack" (by `ok`).
//
// Panel sinks: since bridge protocol 3 the core sends these frames to more than the native
// app. Every frame goes to every attached sink (the app's stdout, and the browser side panel
// through the relay as a bridge `panel` frame), except the answers to one command (`ack`, and
// `preview` chunks), which go only to the sink that sent that command.
export const PanelStateSchema = z.discriminatedUnion("type", [
  PanelStatusStateSchema,
  PanelResultsSchema,
  PanelCapabilitiesSchema,
  PanelPreviewChunkSchema,
  z.discriminatedUnion("ok", [PanelAckOkSchema, PanelAckFailureSchema]),
  PanelAuditSchema,
  PanelGrantSchema,
]);

// --- Native app -> core ---

const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), commandId: CommandIdSchema, ...shape });

export const PreviewCommandSchema = cmd("preview", { resourceId: ResourceIdSchema, version: ContentHashSchema, cursor: PreviewCursorSchema.optional() });
export const ApproveCommandSchema = cmd("approve", { resourceId: ResourceIdSchema, version: ContentHashSchema, expectedRevision: Revision });
export const DeclineCommandSchema = cmd("decline", { resourceId: ResourceIdSchema, version: ContentHashSchema, expectedRevision: Revision });
export const RevokeCommandSchema = cmd("revoke", { resourceId: ResourceIdSchema, expectedRevision: Revision });
/**
 * Auto-acquire for one origin; compare-and-set on `expectedEnabled`, the value the user saw.
 * When the current value differs the ack is `stale_revision` (no `revision`) and nothing
 * changes. A boolean compare cannot tell a retry from a new command after an intervening
 * toggle (enable, disable, retried enable would apply): within one core the commandId cache
 * answers a retry, and the app never retries a toggle across a core restart (new
 * `coreInstanceId`); it sends a new command from the state it then shows.
 */
export const SetAutoAcquireCommandSchema = cmd("set_auto_acquire", { origin: HostOriginSchema, enabled: z.boolean(), expectedEnabled: z.boolean(), acknowledgeRisk: z.boolean() });
/**
 * The user's agent may read browser context; compare-and-set on `expectedEnabled` exactly like
 * `set_auto_acquire`, with the same retry rule: no retry across a core restart. An enable the
 * core does not read back as on (another invalid key in config.json) leaves config.json as it
 * was and acks `invalid`.
 */
export const SetAgentBrowserContextCommandSchema = cmd("set_agent_browser_context", { enabled: z.boolean(), expectedEnabled: z.boolean() });
export const RefreshCapabilitiesCommandSchema = cmd("refresh_capabilities", {});
/**
 * The user clicked a recommended link: the identity the window displayed. The core checks it
 * against the result it holds (instance, visit, job, candidate), re-checks the stored target
 * and the origin's grant, and acks `ok` with `target`, or `stale_revision` (another instance,
 * visit, or job, or the result is gone), `not_found` (no such candidate in the result),
 * `not_permitted` (Chrome no longer grants the origin), `unavailable` (no result registry, or
 * the target failed its re-check). Nothing opens except through this ack.
 */
export const OpenLinkCommandSchema = cmd("open_link", {
  coreInstanceId: CoreInstanceIdSchema,
  visitEpoch: Revision,
  jobId: AgentRequestIdSchema,
  candidateId: PanelCandidateIdSchema,
});

/** The app's frontmost application changed. Only the native app may send it (bridge.ts STDIO_ONLY_COMMANDS). */
export const FrontmostCommandSchema = z.object({ type: z.literal("frontmost"), bundleId: z.string(), at: z.number() });
export const PauseCommandSchema = z.object({ type: z.literal("pause") });
export const ResumeCommandSchema = z.object({ type: z.literal("resume") });
/** Quit the core. Only the native app may send it (bridge.ts STDIO_ONLY_COMMANDS). */
export const ShutdownCommandSchema = z.object({ type: z.literal("shutdown") });

// A new command must also be classified in bridge.ts: relayed from the browser
// (RelayCommandSchema) or native-app only (STDIO_ONLY_COMMANDS). A test enforces it.
export const NativeCommandSchema = z.discriminatedUnion("type", [
  FrontmostCommandSchema,
  PauseCommandSchema,
  ResumeCommandSchema,
  ShutdownCommandSchema,
  PreviewCommandSchema,
  ApproveCommandSchema,
  DeclineCommandSchema,
  RevokeCommandSchema,
  SetAutoAcquireCommandSchema,
  SetAgentBrowserContextCommandSchema,
  RefreshCapabilitiesCommandSchema,
  OpenLinkCommandSchema,
]);

export type PanelResultItem = z.infer<typeof PanelResultItemSchema>;
export type PanelResults = z.infer<typeof PanelResultsSchema>;
export type OpenLinkCommand = z.infer<typeof OpenLinkCommandSchema>;
export type PanelState = z.infer<typeof PanelStateSchema>;
export type PanelStatusState = z.infer<typeof PanelStatusStateSchema>;
export type PanelCapabilities = z.infer<typeof PanelCapabilitiesSchema>;
export type CapabilityOffer = z.infer<typeof CapabilityOfferSchema>;
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;
export type CapabilityConflict = z.infer<typeof CapabilityConflictSchema>;
export type OriginSetting = z.infer<typeof OriginSettingSchema>;
export type PreviewDescriptor = z.infer<typeof PreviewDescriptorSchema>;
export type PanelPreviewChunk = z.infer<typeof PanelPreviewChunkSchema>;
export type AckFailureCode = z.infer<typeof AckFailureCodeSchema>;
export type PanelAck = z.infer<typeof PanelAckOkSchema> | z.infer<typeof PanelAckFailureSchema>;
export type PanelAudit = z.infer<typeof PanelAuditSchema>;
export type PanelGrant = z.infer<typeof PanelGrantSchema>;
export type NativeCommand = z.infer<typeof NativeCommandSchema>;
/** Commands that carry a `commandId` and get an ack (or, for `preview`, a chunk). */
export type PanelCommand = Extract<NativeCommand, { commandId: string }>;
export type PreviewCommand = z.infer<typeof PreviewCommandSchema>;
/** Commands that change stored state or settings. */
export type MutationCommand = Exclude<PanelCommand, PreviewCommand>;
