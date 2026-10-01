// Which stored versions and resources Scout may forget. Pure: store.ts applies the result,
// persists it, and only then deletes blobs that the committed state no longer refers to.
//
// Never collected: the current default (approved) version, any version pinned by an active
// request, and a blocked resource's record (it holds the revocation). Revocation releases
// its resource's pins before any collection runs.

import type { StoredResource, StoreState } from "./decisions.js";

/** Pending or declined versions not seen by discovery for this long are forgotten. */
export const UNUSED_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Non-pinned versions kept per resource (the default is kept even beyond this). */
export const RETAINED_VERSIONS = 5;

/** resourceId → version hashes pinned by active requests. */
export type PinnedVersions = ReadonlyMap<string, ReadonlySet<string>>;

/** Drop expired and surplus versions of one resource in place. Returns how many were dropped. */
export function pruneResource(r: StoredResource, pinned: ReadonlySet<string>, now: number): number {
  const keep = (hash: string) => hash === r.resource.defaultVersion || pinned.has(hash);
  const before = r.resource.versions.length;
  let versions = r.resource.versions.filter((v) => {
    if (keep(v.hash)) return true;
    if (v.state !== "pending" && v.state !== "declined") return true;
    return now - r.meta[v.hash]!.lastSeenAt < UNUSED_EXPIRY_MS;
  });
  // Most recent first by fetch time; ties keep the later-recorded one.
  const ranked = versions
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => !pinned.has(v.hash))
    .sort((a, b) => b.v.fetchedAt - a.v.fetchedAt || b.i - a.i);
  const retained = new Set(ranked.slice(0, RETAINED_VERSIONS).map(({ v }) => v.hash));
  versions = versions.filter((v) => keep(v.hash) || retained.has(v.hash));
  for (const v of r.resource.versions) if (!versions.includes(v)) delete r.meta[v.hash];
  r.resource.versions = versions;
  return before - versions.length;
}

export interface CollectionResult {
  state: StoreState;
  versions: number;
  resources: number;
}

/** Collect across the whole store (input is not modified). An unblocked resource left with no versions is removed. */
export function collect(input: StoreState, pinned: PinnedVersions, now: number): CollectionResult {
  const state = structuredClone(input);
  let versions = 0;
  for (const r of state.resources) {
    const n = pruneResource(r, pinned.get(r.resource.id) ?? new Set(), now);
    if (n > 0) r.revision++;
    versions += n;
  }
  const kept = state.resources.filter((r) => r.resource.blocked || r.resource.versions.length > 0);
  const resources = state.resources.length - kept.length;
  state.resources = kept;
  return { state, versions, resources };
}
