// Names and ownership for the skill wrappers Scout exports into the user's skills root.
// Pure functions only: nothing here touches the filesystem.
//
// A wrapper's name is its directory name under the skills root and the `name` in its
// frontmatter; the CLI requires the two to match. Names follow the Agent Skills rule the
// installed CLI accepts (checked against 2.1.286): lowercase letters, digits and single
// hyphens, at most 64 characters, no leading or trailing hyphen. Scout's names are
// `scout-<kind>-<16 hex>`, the hex taken from the resource ID (itself a SHA-256 of kind +
// source URL), so different resources get different names with overwhelming probability and
// the same resource always gets the same name. Collisions are still checked, against the
// export manifest, never assumed away.
//
// Ownership is never inferred from a name. A directory named `scout-...` that is not in
// Scout's export manifest is the user's, and a manifest entry whose files no longer hash to
// the recorded value was edited by someone else; both are left alone.

import { createHash } from "node:crypto";
import { RESOURCE_ID_PATTERN, type ResourceKind } from "@scout/contracts";

export const SKILL_NAME_MAX = 64;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const KIND_ABBREV: Readonly<Record<ResourceKind, string>> = Object.freeze({ llms_txt: "llms", agents_md: "agents", skill: "skill" });
/** Hex characters of the resource ID kept in the name: 64 bits. */
export const NAME_HASH_CHARS = 16;

export class WrapperIdentityError extends Error {
  constructor(readonly code: "identity: invalid resource id" | "identity: invalid kind" | "identity: name collision") {
    super(code);
    this.name = "WrapperIdentityError";
  }
}

/** Whether `name` is usable as a skill directory and frontmatter name. */
export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name);
}

/** The managed wrapper name for a resource: `scout-<kind>-<first 16 hex of its ID>`. */
export function wrapperName(kind: ResourceKind, resourceId: string): string {
  if (!Object.hasOwn(KIND_ABBREV, kind)) throw new WrapperIdentityError("identity: invalid kind");
  if (typeof resourceId !== "string" || !RESOURCE_ID_PATTERN.test(resourceId)) throw new WrapperIdentityError("identity: invalid resource id");
  return `scout-${KIND_ABBREV[kind]}-${resourceId.slice(4, 4 + NAME_HASH_CHARS)}`;
}

/**
 * Names for a set of resources, refusing any two that map to one name. `owned` maps an
 * existing manifest name to the resource ID it was exported for; a name already owned by a
 * different resource is a collision too.
 */
export function assignWrapperNames(
  resources: readonly { kind: ResourceKind; resourceId: string }[],
  owned: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const r of resources) {
    const name = wrapperName(r.kind, r.resourceId);
    const prior = byName.get(name) ?? owned.get(name);
    if (prior !== undefined && prior !== r.resourceId) throw new WrapperIdentityError("identity: name collision");
    byName.set(name, r.resourceId);
  }
  return byName;
}

/** Exact membership in Scout's export manifest. A `scout-` prefix alone never makes a name Scout's. */
export function isScoutOwnedName(name: string, manifestNames: ReadonlySet<string> | readonly string[]): boolean {
  const names = manifestNames instanceof Set ? manifestNames : new Set(manifestNames as readonly string[]);
  return names.has(name);
}

/** Domain tag that starts every ownership hash input, so the hash cannot be confused with another SHA-256 use. */
export const OWNERSHIP_HASH_TAG = "scout-own-v1\0";

/**
 * SHA-256 (hex) over an export's files: the tag `scout-own-v1\0`, then each relative path and
 * its exact UTF-8 content, length-prefixed (`<byte length>:` before each), in path order. Any
 * edit, added file or rename changes it.
 *
 * Format commitments (an export manifest stores these hashes, so changing any of them makes
 * every recorded wrapper look edited by someone else, and Scout then leaves it alone):
 *   - naming scheme: `scout-<kind abbrev>-<first 16 hex of the resource ID>` (wrapperName);
 *   - hash layout: the tag, then `<len>:<path><len>:<content>` per file in sorted path order;
 *   - the wrapper body includes the approved version hash, so re-exporting a newer version
 *     changes the ownership hash even when nothing else in the text changed.
 * A layout change needs a new tag (`scout-own-v2\0`) and a manifest migration.
 */
export function ownershipHash(files: Readonly<Record<string, string>>): string {
  const h = createHash("sha256");
  h.update(OWNERSHIP_HASH_TAG);
  for (const path of Object.keys(files).sort()) {
    const p = Buffer.from(path, "utf8");
    const c = Buffer.from(files[path]!, "utf8");
    h.update(`${p.length}:`).update(p).update(`${c.length}:`).update(c);
  }
  return h.digest("hex");
}
