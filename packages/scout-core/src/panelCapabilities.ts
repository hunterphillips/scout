// The `capabilities` frame: the native app's whole view of website resources (offers waiting
// for the user, the library, export conflicts, per-origin auto-acquire settings), rebuilt from
// the store and re-sent on every change rather than patched.
//
// An offer is a resource's newest recorded version while it is pending (the same rule ingest's
// auto-acquire uses), on an unblocked resource whose site origin Chrome permits right now, so
// losing a grant drops that origin's offers on the next frame. An older pending version is never
// offered, nor one behind a declined newer one; a declined or revoked version is never an offer,
// and a blocked resource offers nothing however often it is rediscovered.
//
// A library entry lists its newest LIBRARY_VERSIONS_MAX versions, always including the default
// (an older default displaces the oldest other version). Each list is bounded (contracts
// panel.ts), and the serialized frame is kept under CAPABILITIES_FRAME_MAX_BYTES by dropping the
// least recent library entries, then the oldest offers; `truncated` says something was cut.
//
// The emitter coalesces change notifications (debounced) and skips a frame identical to the
// last one sent; `refresh()` sends at once, even when unchanged. Every frame carries the core's
// `coreInstanceId` (drawn once per start); `revision` increases with every frame sent under it,
// so the app can discard an older one and resets its high-water mark when the id changes.

import {
  CORE_INSTANCE_ID_MAX_CHARS,
  CAPABILITY_CONFLICTS_MAX,
  CAPABILITY_LIBRARY_MAX,
  CAPABILITY_OFFERS_MAX,
  CAPABILITY_ORIGINS_MAX,
  CAPABILITIES_FRAME_MAX_BYTES,
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

export type CapabilitiesBody = Omit<PanelCapabilities, "type" | "coreInstanceId" | "revision">;

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
    const v = res.versions.at(-1);
    if (!res.blocked && v?.state === "pending" && isPermitted(res.siteOrigin)) {
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
    const versions = [...res.versions].reverse().sort((a, b) => b.fetchedAt - a.fetchedAt);
    let listed = versions.slice(0, LIBRARY_VERSIONS_MAX);
    const defaultV = versions.find((v) => v.hash === res.defaultVersion);
    // An unlisted default is older than every listed version: it replaces the oldest one.
    if (defaultV && !listed.includes(defaultV)) listed = [...listed.slice(0, -1), defaultV];
    library.push({
      resourceId: res.id,
      kind: res.kind,
      siteOrigin: res.siteOrigin,
      sourceUrl: res.sourceUrl,
      ...(res.defaultVersion !== undefined ? { defaultVersion: res.defaultVersion } : {}),
      state: res.blocked ? "blocked" : res.defaultVersion !== undefined ? "approved" : "no_default",
      versions: listed.map((v) => ({ hash: v.hash, state: v.state, byteLength: v.byteLength, fetchedAt: v.fetchedAt })),
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
  const body: CapabilitiesBody = {
    approvalRevision: state.approvalRevision,
    offers: o.items,
    library: l.items.map(({ newest: _newest, ...entry }) => entry),
    conflicts: c.items.map((x) => ({ name: x.name, resourceId: x.resourceId, code: x.code })),
    origins: g.items,
    truncated: o.cut || l.cut || c.cut || g.cut,
  };
  return fitFrame(body);
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
/** The frame's size as sent, with the longest instance id and largest revision the emitter could stamp on it. */
const frameBytes = (body: CapabilitiesBody): number =>
  bytes({ type: "capabilities", coreInstanceId: "x".repeat(CORE_INSTANCE_ID_MAX_CHARS), revision: Number.MAX_SAFE_INTEGER, ...body });

/**
 * Drop the least recent library entries, then the oldest offers (both lists are newest first),
 * until the serialized frame is under CAPABILITIES_FRAME_MAX_BYTES. Each drop subtracts the
 * element's own bytes (not its comma), so the running total never underestimates; the loop then
 * confirms against the exact size.
 */
function fitFrame(body: CapabilitiesBody): CapabilitiesBody {
  let total = frameBytes(body);
  if (total < CAPABILITIES_FRAME_MAX_BYTES) return body;
  const library = [...body.library];
  const offers = [...body.offers];
  for (;;) {
    while (total >= CAPABILITIES_FRAME_MAX_BYTES && (library.length > 0 || offers.length > 0)) {
      total -= bytes(library.length > 0 ? library.pop() : offers.pop());
    }
    const fitted: CapabilitiesBody = { ...body, library, offers, truncated: true };
    total = frameBytes(fitted);
    if (total < CAPABILITIES_FRAME_MAX_BYTES || (library.length === 0 && offers.length === 0)) return fitted;
  }
}

const rank = (s: OriginSetting, current: string | null): number => (s.autoAcquire ? 2 : 0) + (s.origin === current ? 1 : 0);

export interface CapabilitiesEmitterOptions {
  /** Read on every frame: the store snapshot, conflicts, grants, and current visit right now. */
  input: () => CapabilitiesInput;
  /** This core start's id, stamped on every frame. */
  coreInstanceId: string;
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
    options.emit({ type: "capabilities", coreInstanceId: options.coreInstanceId, revision, ...body });
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
