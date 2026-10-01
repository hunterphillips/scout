// What the live bridge connection says Chrome lets Scout see: the exact origins the user
// granted and the popup's GitHub-capture setting. One snapshot at a time, replaced
// wholesale by each valid `permissions` observation; there is no other grant stream.
//
// Rules:
// - State belongs to one connection. The coordinator clears it when a new sensor attaches
//   and when the live one disconnects, so grants never carry over to a reconnect.
// - Before the first snapshot on a connection nothing is permitted and GitHub capture is
//   off. Focus is still accepted then (it updates Chrome focus), but it cannot form a
//   visit, and page text is refused. An old extension whose snapshot fails validation
//   therefore never gets past this point.
// - A snapshot whose revision is lower than the current one is dropped
//   (`stale_permissions_revision`); an equal or higher one replaces the state.
// - A focus stamped with a `permissionsRevision` lower than the current revision was sent
//   under a superseded snapshot and is dropped (`stale_permissions_revision`). One stamped
//   higher than the current revision means the newer snapshot never arrived (dropped by
//   the relay or rejected by the schema), so the grants here may include an origin the
//   user has since revoked: it is dropped too (`permissions_ahead`), failing closed until
//   that snapshot arrives. A focus without a revision is accepted; the visit tracker still
//   checks its origin against the current grants.
// - Granted patterns (`https://<host>/*`, validated by the contract) are kept as origins.

import type { FocusObservation, PermissionsObservation } from "@scout/contracts";
import type { Diagnostics } from "./diagnostics.js";

export const GITHUB_ORIGIN = "https://github.com";

export interface PermissionState {
  /** Replace the state with `snapshot`, or drop it if older. True when applied. */
  applySnapshot(snapshot: PermissionsObservation): boolean;
  /** False (and logged) when the focus was sent under a different snapshot than the current one. */
  acceptsFocus(focus: FocusObservation): boolean;
  /** True when the current snapshot grants exactly this origin (`https://host`). */
  isPermitted(origin: string): boolean;
  /** Forget everything: the connection this state belonged to is gone. */
  clear(): void;
  /** Whether a valid snapshot has arrived on this connection. */
  readonly received: boolean;
  /** The current snapshot's revision, or null before the first one. */
  readonly revision: number | null;
  /** The popup's GitHub-capture setting from the current snapshot; false before one. */
  readonly githubCapture: boolean;
}

interface Snapshot {
  revision: number;
  at: number;
  granted: ReadonlySet<string>;
  githubCapture: boolean;
}

export function createPermissionState(options: { diagnostics?: Diagnostics } = {}): PermissionState {
  const { diagnostics } = options;
  let current: Snapshot | null = null;

  return {
    get received() {
      return current !== null;
    },
    get revision() {
      return current?.revision ?? null;
    },
    get githubCapture() {
      return current?.githubCapture ?? false;
    },
    applySnapshot(snapshot) {
      if (current !== null && snapshot.revision < current.revision) {
        diagnostics?.event("permissions_dropped", { reason: "stale_permissions_revision", revision: snapshot.revision });
        return false;
      }
      current = {
        revision: snapshot.revision,
        at: snapshot.at,
        granted: new Set(snapshot.granted.map(patternToOrigin)),
        githubCapture: snapshot.githubCapture,
      };
      diagnostics?.event("permissions", {
        revision: snapshot.revision,
        granted: current.granted.size,
        githubCapture: snapshot.githubCapture,
      });
      return true;
    },
    acceptsFocus(focus) {
      if (current === null || focus.permissionsRevision === undefined) return true;
      if (focus.permissionsRevision < current.revision) {
        diagnostics?.event("focus_dropped", { reason: "stale_permissions_revision", revision: focus.permissionsRevision });
        return false;
      }
      if (focus.permissionsRevision > current.revision) {
        diagnostics?.event("focus_dropped", { reason: "permissions_ahead", revision: focus.permissionsRevision });
        return false;
      }
      return true;
    },
    isPermitted: (origin) => current?.granted.has(origin) ?? false,
    clear() {
      current = null;
    },
  };
}

/** `https://host/*` (already validated as an exact origin pattern) to `https://host`. */
export function patternToOrigin(pattern: string): string {
  return new URL(pattern.slice(0, -2)).origin;
}
