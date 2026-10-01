// The `capabilities` frame: the native app's whole view of website resources (offers waiting
// for the user, the library, export conflicts, per-origin auto-acquire settings), rebuilt from
// the store and re-sent on every change rather than patched.
//
// Offers are the pending versions of unblocked resources whose site origin Chrome permits
// right now, so losing a grant drops that origin's offers on the next frame. A declined or
// revoked version is never an offer, and a blocked resource offers nothing however often it is
// rediscovered. Each list is bounded (contracts panel.ts); `truncated` says one was cut.
//
// The emitter coalesces change notifications (debounced) and skips a frame identical to the
// last one sent; `refresh()` sends at once, even when unchanged. `revision` increases with
// every frame sent, so the app can discard an older one.

import {
  CAPABILITY_CONFLICTS_MAX,
  CAPABILITY_LIBRARY_MAX,
  CAPABILITY_OFFERS_MAX,
  CAPABILITY_ORIGINS_MAX,
  LIBRARY_VERSIONS_MAX,
  type CapabilityOffer,
  type LibraryEntry,
  type OriginSetting,
  type PanelCapabilities,
} from "@scout/contracts";
import type { StoreState } from "./capabilities/decisions.js";
import type { ExportConflict } from "./capabilities/exports.js";
import type { Timers } from "./clock.js";
import { createDebounced } from "./debounced.js";
import type { Diagnostics } from "./diagnostics.js";

/** How long change notifications coalesce before a frame goes out. */
export const CAPABILITIES_DEBOUNCE_MS = 100;

export interface CapabilitiesInput {
  state: StoreState;
  conflicts: readonly ExportConflict[];
  isPermitted: (origin: string) => boolean;
  /** The current visit's origin, listed among the origin settings even with no resources. */
  currentOrigin: string | null;
}

export type CapabilitiesBody = Omit<PanelCapabilities, "type" | "revision">;

function cut<T>(items: readonly T[], max: number): { items: T[]; cut: boolean } {
  return { items: items.slice(0, max), cut: items.length > max };
}

/** The frame body for `input`. Pure. */
export function buildCapabilities(input: CapabilitiesInput): CapabilitiesBody {
  const { state, isPermitted } = input;
  const offers: CapabilityOffer[] = [];
  const library: (LibraryEntry & { newest: number })[] = [];
  for (const r of state.resources) {
    const res = r.resource;
    if (!res.blocked && isPermitted(res.siteOrigin)) {
      for (const v of res.versions) {
        if (v.state !== "pending") continue;
        const skill = r.meta[v.hash]?.skill;
        offers.push({
          resourceId: res.id,
          version: v.hash,
          kind: res.kind,
          siteOrigin: res.siteOrigin,
          sourceUrl: res.sourceUrl,
          byteLength: v.byteLength,
          fetchedAt: v.fetchedAt,
          resourceRevision: r.revision,
          ...(skill ? { skill: { name: skill.name, ...(skill.description !== undefined ? { description: skill.description } : {}) } } : {}),
        });
      }
    }
    const versions = [...res.versions].reverse().sort((a, b) => b.fetchedAt - a.fetchedAt);
    library.push({
      resourceId: res.id,
      kind: res.kind,
      siteOrigin: res.siteOrigin,
      sourceUrl: res.sourceUrl,
      ...(res.defaultVersion !== undefined ? { defaultVersion: res.defaultVersion } : {}),
      state: res.blocked ? "blocked" : res.defaultVersion !== undefined ? "approved" : "pending_only",
      versions: versions.slice(0, LIBRARY_VERSIONS_MAX).map((v) => ({ hash: v.hash, state: v.state, byteLength: v.byteLength, fetchedAt: v.fetchedAt })),
      resourceRevision: r.revision,
      newest: versions[0]?.fetchedAt ?? 0,
    });
  }
  offers.sort((a, b) => b.fetchedAt - a.fetchedAt);
  library.sort((a, b) => b.newest - a.newest);

  const policies = new Map(state.policies.map((p) => [p.origin, p]));
  const originSet = new Set<string>([...policies.keys(), ...state.resources.map((r) => r.resource.siteOrigin)]);
  if (input.currentOrigin !== null) originSet.add(input.currentOrigin);
  const origins: OriginSetting[] = [...originSet].sort().map((origin) => {
    const p = policies.get(origin);
    return { origin, autoAcquire: p !== undefined, ...(p ? { acknowledgedAt: p.riskAcknowledgedAt } : {}), permitted: isPermitted(origin) };
  });
  // Origins with auto-acquire on, then the current one, survive the cut first.
  origins.sort((a, b) => rank(b, input.currentOrigin) - rank(a, input.currentOrigin));

  const o = cut(offers, CAPABILITY_OFFERS_MAX);
  const l = cut(library, CAPABILITY_LIBRARY_MAX);
  const c = cut(input.conflicts, CAPABILITY_CONFLICTS_MAX);
  const g = cut(origins, CAPABILITY_ORIGINS_MAX);
  return {
    approvalRevision: state.approvalRevision,
    offers: o.items,
    library: l.items.map(({ newest: _newest, ...entry }) => entry),
    conflicts: c.items.map((x) => ({ name: x.name, resourceId: x.resourceId, code: x.code })),
    origins: g.items,
    truncated: o.cut || l.cut || c.cut || g.cut,
  };
}

const rank = (s: OriginSetting, current: string | null): number => (s.autoAcquire ? 2 : 0) + (s.origin === current ? 1 : 0);

export interface CapabilitiesEmitterOptions {
  /** Read on every frame: the store snapshot, conflicts, grants, and current visit right now. */
  input: () => CapabilitiesInput;
  emit: (frame: PanelCapabilities) => void;
  timers?: Timers;
  delayMs?: number;
  diagnostics?: Diagnostics;
}

export interface CapabilitiesEmitter {
  /** Something the frame shows may have changed: send a frame soon if it did. */
  changed(): void;
  /** Send a frame now, even if nothing changed. */
  refresh(): void;
  /** Drop any pending frame; later calls send nothing. */
  stop(): void;
  /** The revision of the last frame sent (0 before the first). */
  readonly revision: number;
}

export function createCapabilitiesEmitter(options: CapabilitiesEmitterOptions): CapabilitiesEmitter {
  let revision = 0;
  let last: string | null = null;
  let stopped = false;

  const send = (force: boolean): void => {
    if (stopped) return;
    let body: CapabilitiesBody;
    try {
      body = buildCapabilities(options.input());
    } catch {
      options.diagnostics?.event("capabilities_failed", {});
      return;
    }
    const key = JSON.stringify(body);
    if (!force && key === last) return;
    last = key;
    revision++;
    options.diagnostics?.event("capabilities_emitted", { offers: body.offers.length, library: body.library.length, truncated: body.truncated });
    options.emit({ type: "capabilities", revision, ...body });
  };
  const debounced = createDebounced(() => send(false), options.delayMs ?? CAPABILITIES_DEBOUNCE_MS, options.timers);

  return {
    changed: () => {
      if (!stopped) debounced.schedule();
    },
    refresh: () => {
      debounced.cancel();
      send(true);
    },
    stop: () => {
      stopped = true;
      debounced.cancel();
    },
    get revision() {
      return revision;
    },
  };
}
