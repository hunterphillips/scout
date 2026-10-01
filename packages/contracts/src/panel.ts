// The JSONL link between the native app and the core (stdio): what the core shows the user
// and the commands the app sends back. Browser-safe like the rest of the root export.
//
// Core -> app frames are discriminated by `type`; two types carry a second discriminator the
// Swift decoder reads: `results` by `status`, `ack` by `ok`.
//
// App -> core commands must each fit in one atomic pipe write (NATIVE_COMMAND_MAX_BYTES, the
// platform's PIPE_BUF): the app drops a larger write rather than splitting it. So commands
// carry IDs, hashes, revisions, and cursors only; never resource text or tool configuration.
// Every new command carries a `commandId`; the core answers each one with exactly one `ack`
// (a successful `preview` answers with a `preview` chunk instead). A retried `commandId`
// whose effect already applied gets the same `ok: true` ack and changes nothing.

import { z } from "zod";
import { AGENT_METHODS } from "./agent.js";
import {
  ContentHashSchema,
  HttpsOriginSchema,
  ResourceIdSchema,
  ResourceKindSchema,
  ResourceVersionStateSchema,
  SourceUrlSchema,
} from "./capability.js";

/** PIPE_BUF on macOS: one JSONL command line, newline included, must be shorter than this. */
export const NATIVE_COMMAND_MAX_BYTES = 4096;
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

// --- Core -> native app ---

export const PanelStatusStateSchema = z.object({
  type: z.literal("state"),
  status: z.enum(["idle", "working", "paused", "disconnected"]),
  visitEpoch: z.int().nonnegative().optional(),
  detail: z.string().optional(),
  /** On `idle`: whether a visit to a Chrome-permitted origin is current. Absent on other statuses. */
  permitted: z.boolean().optional(),
});

export const PanelResultItemSchema = z.object({
  candidateId: z.string(),
  title: z.string(),
  href: z.string(),
  reason: z.string(),
});

export const PanelResultsListSchema = z.object({
  type: z.literal("results"),
  visitEpoch: z.int().nonnegative(),
  status: z.enum(["ok", "empty"]),
  items: z.array(PanelResultItemSchema),
});

export const PanelResultsFailureSchema = z.object({
  type: z.literal("results"),
  visitEpoch: z.int().nonnegative(),
  status: z.enum(["unavailable", "error"]),
  reason: z.string(),
});

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
  origin: HttpsOriginSchema,
  autoAcquire: z.boolean(),
  /** When the user acknowledged the auto-acquire risk; present only while auto-acquire is on. */
  acknowledgedAt: z.number().optional(),
  /** Chrome currently grants this origin. Auto-acquire acts only while it does. */
  permitted: z.boolean(),
});

/** The whole capability view, re-sent on every change. */
export const PanelCapabilitiesSchema = z.object({
  type: z.literal("capabilities"),
  /** Increases with every frame this core sends; a lower one is stale. */
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
  outcome: z.string(),
  origin: z.string().optional(),
});

/** Recent browser-context reads by the user's agent, oldest first. Never the text read. */
export const PanelAuditSchema = z.object({
  type: z.literal("audit"),
  entries: z.array(AuditEntrySchema).max(PANEL_AUDIT_MAX),
});

/** Whether the user's interactive agent may read browser context. */
export const PanelGrantSchema = z.object({
  type: z.literal("grant"),
  agentBrowserContext: z.boolean(),
});

// Two members share type "results" (by `status`) and two share "ack" (by `ok`).
export const PanelStateSchema = z.discriminatedUnion("type", [
  PanelStatusStateSchema,
  z.discriminatedUnion("status", [PanelResultsListSchema, PanelResultsFailureSchema]),
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
export const SetAutoAcquireCommandSchema = cmd("set_auto_acquire", { origin: HttpsOriginSchema, enabled: z.boolean(), acknowledgeRisk: z.boolean() });
export const SetAgentBrowserContextCommandSchema = cmd("set_agent_browser_context", { enabled: z.boolean() });
export const RefreshCapabilitiesCommandSchema = cmd("refresh_capabilities", {});

export const NativeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frontmost"), bundleId: z.string(), at: z.number() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("shutdown") }),
  PreviewCommandSchema,
  ApproveCommandSchema,
  DeclineCommandSchema,
  RevokeCommandSchema,
  SetAutoAcquireCommandSchema,
  SetAgentBrowserContextCommandSchema,
  RefreshCapabilitiesCommandSchema,
]);

export type PanelResultItem = z.infer<typeof PanelResultItemSchema>;
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
