import { z } from "zod";
import { PAGE_TEXT_BODY_MAX_BYTES, PAGE_TEXT_TITLE_MAX_CHARS } from "./browser.js";
import { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX } from "./catalog.js";
import {
  ContentHashSchema,
  HttpsOriginSchema,
  RESOURCE_MAX_BYTES,
  ResourceIdSchema,
  ResourceKindSchema,
  SOURCE_URL_MAX_CHARS,
  SourceUrlSchema,
} from "./capability.js";

// The read-only agent protocol on `run/agent.sock`: Scout's MCP adapter -> core. It is
// separate from the browser protocol on `run/core.sock`; neither accepts the other's frames.
//
// Every request names one method. There are no approval, grant-change, open-link, or other
// mutation methods, and none may be added here: the agent reads Scout's data, it never
// changes it. The first request on a connection is `hello` (protocol version + token); the
// core authenticates it and answers every later request on that connection with the grant
// the token carries. Tokens are secrets: never log them or put them in prompts or skills.
//
// Frames use the length-prefixed codec at `@scout/contracts/frame` with the caps below.

export const AGENT_PROTOCOL_VERSION = 1;
/** Largest request frame body, in bytes. */
export const AGENT_REQUEST_MAX_BYTES = 16 * 1024;
/** Largest response frame body, in bytes. Lists are paged to fit it. */
export const AGENT_RESPONSE_MAX_BYTES = 64 * 1024;
/** Largest `read_resource` chunk of text, in UTF-8 bytes; chunks never split a code point. */
export const RESOURCE_CHUNK_MAX_BYTES = 16 * 1024;
/** A paging/read cursor expires this long after it was issued. */
export const AGENT_CURSOR_TTL_MS = 5 * 60 * 1000;

export const AGENT_REQUEST_ID_MAX_CHARS = 64;
export const AGENT_CURSOR_MAX_CHARS = 128;
export const AGENT_TOKEN_MAX_CHARS = 256;
export const CORE_INSTANCE_ID_MAX_CHARS = 64;
export const AGENT_ERROR_MESSAGE_MAX_CHARS = 200;

export const RECENT_ACTIVITY_MAX_LIMIT = 10;
export const LIST_MAX_LIMIT = 50;

/**
 * The closed set of operational statuses. Only Scout produces these; an agent or model
 * cannot invent another.
 */
export const AGENT_STATUS_CODES = [
  "not_granted",
  "paused",
  "revoked",
  "not_found",
  "expired_snapshot",
  "limit_exceeded",
  "unavailable",
  "protocol_mismatch",
] as const;
export const AgentStatusCodeSchema = z.enum(AGENT_STATUS_CODES);

const opaque = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
export const AgentRequestIdSchema = opaque(AGENT_REQUEST_ID_MAX_CHARS);
/** Opaque to the client. A read cursor pins the resource version it was issued for. */
export const AgentCursorSchema = opaque(AGENT_CURSOR_MAX_CHARS);
export const AgentTokenSchema = opaque(AGENT_TOKEN_MAX_CHARS);
export const CoreInstanceIdSchema = opaque(CORE_INSTANCE_ID_MAX_CHARS);
/** Any int on the wire, so the receiver can answer `protocol_mismatch` instead of dropping the frame. */
const ProtocolSchema = z.int().min(0).max(65_535);

// ---------- method parameters ----------

export const HelloParamsSchema = z.strictObject({ token: AgentTokenSchema });
export const CurrentSiteParamsSchema = z.strictObject({});
export const RecentActivityParamsSchema = z.strictObject({
  limit: z.int().min(1).max(RECENT_ACTIVITY_MAX_LIMIT).optional(),
  cursor: AgentCursorSchema.optional(),
});
export const SiteLinksParamsSchema = z.strictObject({
  limit: z.int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: AgentCursorSchema.optional(),
});
export const ListResourcesParamsSchema = z.strictObject({
  /** Only resources discovered on this site. */
  origin: HttpsOriginSchema.optional(),
  limit: z.int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: AgentCursorSchema.optional(),
});
export const ReadResourceParamsSchema = z.strictObject({
  resourceId: ResourceIdSchema,
  /** A specific approved version; defaults to the resource's current approved version. */
  version: ContentHashSchema.optional(),
  /** Continues a read; must have been issued for the same resource (and version, if given). */
  cursor: AgentCursorSchema.optional(),
});

export const AGENT_METHODS = ["hello", "current_site", "recent_activity", "site_links", "list_resources", "read_resource"] as const;
export type AgentMethod = (typeof AGENT_METHODS)[number];

const request = <M extends AgentMethod, P extends z.ZodType>(method: M, params: P) =>
  z.strictObject({ protocol: ProtocolSchema, requestId: AgentRequestIdSchema, method: z.literal(method), params });

export const AgentRequestSchema = z.discriminatedUnion("method", [
  request("hello", HelloParamsSchema),
  request("current_site", CurrentSiteParamsSchema),
  request("recent_activity", RecentActivityParamsSchema),
  request("site_links", SiteLinksParamsSchema),
  request("list_resources", ListResourcesParamsSchema),
  request("read_resource", ReadResourceParamsSchema),
]);

// ---------- method results ----------

const UrlSchema = z.string().max(SOURCE_URL_MAX_CHARS);
const utf8Encoder = new TextEncoder();
const maxUtf8 = (bytes: number) =>
  z.string().refine((t) => utf8Encoder.encode(t).byteLength <= bytes, { message: `text exceeds ${bytes} bytes` });

export const HelloResultSchema = z.object({ role: z.enum(["interactive", "job"]) });

export const CurrentSiteResultSchema = z.object({
  /** Null when no permitted page is in focus. Never a placeholder site. */
  site: z
    .object({
      origin: HttpsOriginSchema,
      url: UrlSchema,
      /** Website-authored. */
      title: z.string().max(PAGE_TEXT_TITLE_MAX_CHARS).optional(),
      visitEpoch: z.int().nonnegative(),
    })
    .nullable(),
});

export const ActivityEntrySchema = z.object({
  origin: HttpsOriginSchema,
  url: UrlSchema,
  observedAt: z.number(),
  /** Website-authored. */
  title: z.string().max(PAGE_TEXT_TITLE_MAX_CHARS),
  /** Website-authored. */
  text: maxUtf8(PAGE_TEXT_BODY_MAX_BYTES).optional(),
  textTruncated: z.boolean(),
});

export const RecentActivityResultSchema = z.object({
  entries: z.array(ActivityEntrySchema).max(RECENT_ACTIVITY_MAX_LIMIT),
  nextCursor: AgentCursorSchema.optional(),
});

export const SiteLinkSchema = z.object({
  id: z.string().regex(/^c[0-9a-z]+$/),
  href: UrlSchema,
  /** Website-authored. */
  title: z.string().max(CANDIDATE_TITLE_MAX),
  /** Website-authored. */
  description: z.string().max(CANDIDATE_DESCRIPTION_MAX).optional(),
});

export const SiteLinksResultSchema = z.object({
  origin: HttpsOriginSchema,
  catalogVersion: z.string().min(1).max(128),
  total: z.int().nonnegative(),
  links: z.array(SiteLinkSchema).max(LIST_MAX_LIMIT),
  nextCursor: AgentCursorSchema.optional(),
});

/**
 * How a readable version stands. Agents only ever see approved text: `approved` is the
 * resource's current default, `superseded` an older approved version still readable by
 * explicit version.
 */
export const AgentApprovalSchema = z.enum(["approved", "superseded"]);

const ResourceIdentityShape = {
  resourceId: ResourceIdSchema,
  kind: ResourceKindSchema,
  siteOrigin: HttpsOriginSchema,
  publisherOrigin: HttpsOriginSchema,
  sourceUrl: SourceUrlSchema,
  version: ContentHashSchema,
  approval: AgentApprovalSchema,
};

export const ResourceSummarySchema = z.object({
  ...ResourceIdentityShape,
  totalBytes: z.int().min(0).max(RESOURCE_MAX_BYTES),
  approvedAt: z.number(),
});

export const ListResourcesResultSchema = z.object({
  resources: z.array(ResourceSummarySchema).max(LIST_MAX_LIMIT),
  nextCursor: AgentCursorSchema.optional(),
});

export const ReadResourceResultSchema = z.object({
  ...ResourceIdentityShape,
  /** Byte offset of `text` within the version. */
  offset: z.int().min(0).max(RESOURCE_MAX_BYTES),
  totalBytes: z.int().min(0).max(RESOURCE_MAX_BYTES),
  /** Website-authored. */
  text: maxUtf8(RESOURCE_CHUNK_MAX_BYTES),
  /** Absent on the last chunk. */
  nextCursor: AgentCursorSchema.optional(),
});

export const AGENT_RESULT_SCHEMAS = {
  hello: HelloResultSchema,
  current_site: CurrentSiteResultSchema,
  recent_activity: RecentActivityResultSchema,
  site_links: SiteLinksResultSchema,
  list_resources: ListResourcesResultSchema,
  read_resource: ReadResourceResultSchema,
} as const satisfies Record<AgentMethod, z.ZodType>;

// ---------- responses ----------

export const AgentErrorSchema = z.object({
  code: AgentStatusCodeSchema,
  /** For diagnostics; clients show their own fixed text per code. */
  message: z.string().max(AGENT_ERROR_MESSAGE_MAX_CHARS),
});

const envelope = {
  protocol: ProtocolSchema,
  requestId: AgentRequestIdSchema,
  /** Random per core process start; a restarted core never reuses one. */
  coreInstanceId: CoreInstanceIdSchema,
};

export const AgentErrorResponseSchema = z.object({ ...envelope, status: z.literal("error"), error: AgentErrorSchema });

/** The response schema for one method: its `ok` result, or an error. */
export function agentResponseSchema<M extends AgentMethod>(method: M) {
  return z.discriminatedUnion("status", [
    z.object({ ...envelope, status: z.literal("ok"), result: AGENT_RESULT_SCHEMAS[method] as (typeof AGENT_RESULT_SCHEMAS)[M] }),
    AgentErrorResponseSchema,
  ]);
}

/** Any response, result unchecked; use agentResponseSchema(method) to check the result. */
export const AgentResponseEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({ ...envelope, status: z.literal("ok"), result: z.record(z.string(), z.unknown()) }),
  AgentErrorResponseSchema,
]);

export type AgentStatusCode = z.infer<typeof AgentStatusCodeSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentRequestOf<M extends AgentMethod> = Extract<AgentRequest, { method: M }>;
export type AgentParams<M extends AgentMethod> = AgentRequestOf<M>["params"];
export type AgentResult<M extends AgentMethod> = z.infer<(typeof AGENT_RESULT_SCHEMAS)[M]>;
export type AgentError = z.infer<typeof AgentErrorSchema>;
export type AgentErrorResponse = z.infer<typeof AgentErrorResponseSchema>;
export type AgentResponse<M extends AgentMethod = AgentMethod> =
  | { protocol: number; requestId: string; coreInstanceId: string; status: "ok"; result: AgentResult<M> }
  | AgentErrorResponse;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type SiteLink = z.infer<typeof SiteLinkSchema>;
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
export type CurrentSiteResult = z.infer<typeof CurrentSiteResultSchema>;
export type RecentActivityResult = z.infer<typeof RecentActivityResultSchema>;
export type SiteLinksResult = z.infer<typeof SiteLinksResultSchema>;
export type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;
export type ReadResourceResult = z.infer<typeof ReadResourceResultSchema>;
