import { z } from "zod";

// Website resources Scout stores and offers to the user's agent: site guides (llms.txt,
// AGENTS.md) and single-file skills. Browser-safe: no Node built-ins.

export const RESOURCE_KINDS = ["llms_txt", "agents_md", "skill"] as const;
export const ResourceKindSchema = z.enum(RESOURCE_KINDS);

/** Largest single resource Scout accepts (the root llms.txt / AGENTS.md cap). */
export const RESOURCE_MAX_BYTES = 128 * 1024;
export const SOURCE_URL_MAX_CHARS = 2048;
/** Stored versions per resource: five non-pinned plus versions pinned by active requests. */
export const RESOURCE_MAX_VERSIONS = 16;

/** `res_` + 64 lowercase hex: see deriveResourceId. */
export const RESOURCE_ID_PATTERN = /^res_[0-9a-f]{64}$/;
/** A full SHA-256, lowercase hex. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** RFC 1123 hostname, lowercase: labels of letters, digits and inner hyphens, dot-separated. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
export const HOSTNAME_MAX_CHARS = 253;
const LABEL_MAX_CHARS = 63;

/**
 * True when `v` is exactly an https origin `https://host[:port]`: the host an RFC 1123
 * hostname (lowercase, at most 253 characters, labels at most 63), the port 1-65535 if
 * present, no userinfo, path, query or fragment, and `v` is its own WHATWG origin (so the
 * default port, leading zeros and anything the URL parser would rewrite are refused). IP
 * literals are refused: an all-digit last label is what WHATWG reads as IPv4, and `[...]`
 * never matches. Scout only targets hostnames.
 */
export function isHttpsOrigin(v: string): boolean {
  if (typeof v !== "string") return false;
  const m = /^https:\/\/([^:/?#@\[\]]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return false;
  const host = m[1]!;
  if (host.length > HOSTNAME_MAX_CHARS || !HOSTNAME_RE.test(host)) return false;
  const labels = host.split(".");
  if (labels.some((l) => l.length > LABEL_MAX_CHARS) || /^\d+$/.test(labels.at(-1)!)) return false;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return false;
  }
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.origin === v;
  } catch {
    return false;
  }
}

/**
 * True when `v` is an https URL already in canonical form: WHATWG-serialized (so the host
 * is lowercased and dot segments resolved), no credentials, no fragment.
 */
export function isCanonicalSourceUrl(v: string): boolean {
  if (v.length > SOURCE_URL_MAX_CHARS) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.href === v && u.username === "" && u.password === "" && u.hash === "";
  } catch {
    return false;
  }
}

export const HttpsOriginSchema = z.string().max(SOURCE_URL_MAX_CHARS).refine(isHttpsOrigin, { message: "not an https origin" });
export const SourceUrlSchema = z.string().refine(isCanonicalSourceUrl, { message: "not a canonical https source URL" });
export const ResourceIdSchema = z.string().regex(RESOURCE_ID_PATTERN);
/**
 * A version's content hash: full SHA-256 over the bytes plus the previewed descriptor. The
 * byte encoding of that input is the store's (scout-core, P2.3); this module fixes only its
 * shape. Versions are named by this hash on the wire.
 */
export const ContentHashSchema = z.string().regex(SHA256_HEX_PATTERN);

/**
 * The stable resource ID: `res_` + lowercase hex of SHA-256 over the UTF-8 bytes of
 * `kind + "\n" + canonicalSourceUrl`. The derivation lives here, with Web Crypto, so the
 * core and any fixture compute the same ID; Web Crypto keeps it browser-safe, which makes
 * it async. Throws on a non-canonical URL rather than canonicalizing silently.
 */
export async function deriveResourceId(kind: ResourceKind, canonicalSourceUrl: string): Promise<string> {
  if (!isCanonicalSourceUrl(canonicalSourceUrl)) throw new TypeError("source URL is not canonical");
  const input = new TextEncoder().encode(`${kind}\n${canonicalSourceUrl}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return `res_${hex}`;
}

export const RESOURCE_VERSION_STATES = ["pending", "approved", "superseded", "declined", "revoked"] as const;
export const ResourceVersionStateSchema = z.enum(RESOURCE_VERSION_STATES);

/** Who made a version's decision: the user in Scout's window, or the per-origin auto-acquire policy. */
export const DecisionActorSchema = z.enum(["user", "auto_acquire"]);

export const ResourceDecisionSchema = z.object({
  actor: DecisionActorSchema,
  at: z.number(),
});

/** One immutable fetched version of a resource. Only `state` and `decision` ever change. */
export const ResourceVersionSchema = z
  .object({
    hash: ContentHashSchema,
    /** Names the immutable blob `capabilities/blobs/<blobRef>.txt`. */
    blobRef: z.string().regex(SHA256_HEX_PATTERN),
    byteLength: z.int().min(0).max(RESOURCE_MAX_BYTES),
    fetchedAt: z.number(),
    state: ResourceVersionStateSchema,
    /** Absent only while pending; superseded versions keep the decision that approved them. */
    decision: ResourceDecisionSchema.optional(),
  })
  .refine((v) => (v.state === "pending") === (v.decision === undefined), {
    message: "a pending version has no decision; every other state has one",
  });

export const ResourceSchema = z
  .object({
    id: ResourceIdSchema,
    kind: ResourceKindSchema,
    /** The site the user was on when Scout discovered it. */
    siteOrigin: HttpsOriginSchema,
    /** The origin of `sourceUrl`. A cross-origin resource is a reference, not the site's own text. */
    publisherOrigin: HttpsOriginSchema,
    sourceUrl: SourceUrlSchema,
    versions: z.array(ResourceVersionSchema).max(RESOURCE_MAX_VERSIONS),
    /** The version agent reads get by default; must be one of `versions` in state `approved`. */
    defaultVersion: ContentHashSchema.optional(),
    /**
     * Set by revocation. While blocked no version is readable and rediscovery or auto-acquire
     * cannot unblock it; only an explicit re-approval clears it.
     */
    blocked: z.boolean(),
  })
  .refine((r) => new URL(r.sourceUrl).origin === r.publisherOrigin, { message: "publisherOrigin must be the source URL's origin" })
  .refine((r) => new Set(r.versions.map((v) => v.hash)).size === r.versions.length, { message: "duplicate version hash" })
  .refine(
    (r) => r.defaultVersion === undefined || r.versions.some((v) => v.hash === r.defaultVersion && v.state === "approved"),
    { message: "defaultVersion must name an approved version" },
  )
  .refine((r) => !(r.blocked && r.defaultVersion !== undefined), { message: "a blocked resource has no default version" });

export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export type ResourceVersionState = z.infer<typeof ResourceVersionStateSchema>;
export type DecisionActor = z.infer<typeof DecisionActorSchema>;
export type ResourceDecision = z.infer<typeof ResourceDecisionSchema>;
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
