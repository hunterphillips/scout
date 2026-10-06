// Turns Chrome focus plus the Mac's frontmost app into the current visit: a permitted
// https page in the focused Chrome window. A visit starts only while Chrome is frontmost.
// "Permitted" means the live connection's permissions snapshot grants the page's exact
// origin (injected as `isPermitted`); whether recommendations are enabled for that origin is
// a separate setting this tracker does not read. Every real change of the visit tuple is a
// new epoch.
//
// Another app coming to the front is not a real change. While Chrome is not frontmost, or no
// Chrome window has focus, the visit is kept with its epoch and marked `away`
// (`visit_suspended`); when Chrome and the same tab, document and URL come back, it is marked
// present again (`visit_resumed`) with no new epoch. `onChange` hears neither. A focus that
// shows another page, the origin's grant lost, or `reset()` (the sensor is gone) ends a kept
// visit as a real change. Chrome reports no tab while unfocused, so a page changed in the
// background is seen only when Chrome is focused again.

import type { ActiveVisit, FocusObservation, NativeCommand } from "@scout/contracts";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

export const CHROME_BUNDLE_ID = "com.google.Chrome";

/** chrome.windows.WINDOW_ID_NONE: no Chrome window has focus. */
export const WINDOW_ID_NONE = -1;

export interface VisitChange {
  epoch: number;
  /** null means idle: no permitted page is in front. */
  visit: ActiveVisit | null;
  /** The visit this change replaces; null means the tracker was idle. idle to idle is possible. */
  previous: ActiveVisit | null;
}

/** The kept visit went away (another app in front) or came back. */
export interface VisitPresence {
  epoch: number;
  away: boolean;
}

export interface VisitTrackerOptions {
  /** True when Chrome currently grants this exact origin (`https://host`, default port). */
  isPermitted: (origin: string) => boolean;
  chromeBundleId?: string;
  clock: Clock;
  /**
   * Called synchronously on every real change, never on a duplicate. A throw is caught and
   * logged, never rethrown. Re-entry is not supported: the handler must not call
   * observeFocus, observeFrontmost, or recompute.
   */
  onChange: (change: VisitChange) => void;
  /** Called when the current visit goes away or comes back (same rules as `onChange`). */
  onPresence?: (presence: VisitPresence) => void;
  /** Scout's current contextRevision, stamped on each new visit. */
  getContextRevision?: () => number;
  diagnostics?: Diagnostics;
}

export interface VisitTracker {
  observeFocus(obs: FocusObservation): void;
  observeFrontmost(cmd: Extract<NativeCommand, { type: "frontmost" }>): void;
  /** Re-check the tuple against `isPermitted` (the permissions snapshot changed). Losing the current origin ends the visit. */
  recompute(): void;
  /** Forget the focus and end any visit, kept or not (the sensor is gone). */
  reset(): void;
  /** The current visit; while `away` it is the page still focused in Chrome. */
  current(): ActiveVisit | null;
  /** True while the current visit is kept with another app in front. */
  readonly away: boolean;
  readonly epoch: number;
}

/** The six values that define the active state. Anything else (e.g. title) is ignored. */
interface VisitTuple {
  chromeFrontmost: boolean;
  browserFocused: boolean;
  tabId: number | null;
  documentId: string | null;
  url: string | null;
  permittedOrigin: string | null;
}

const EMPTY_TUPLE: VisitTuple = {
  chromeFrontmost: false,
  browserFocused: false,
  tabId: null,
  documentId: null,
  url: null,
  permittedOrigin: null,
};

/**
 * Combines the latest `focus` observation with the latest `frontmost` command. Frontmost
 * is unknown (treated as not Chrome) until the first `frontmost` command arrives.
 */
export function createVisitTracker(options: VisitTrackerOptions): VisitTracker {
  const chromeBundleId = options.chromeBundleId ?? CHROME_BUNDLE_ID;
  const getContextRevision = options.getContextRevision ?? (() => 0);

  let focus: FocusObservation | null = null;
  let frontmostBundleId: string | null = null;
  let tuple: VisitTuple = EMPTY_TUPLE;
  let epoch = 0;
  let visit: ActiveVisit | null = null;
  let away = false;

  const permittedOrigin = (url: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // Grants are exact host patterns with no port, so a port-bearing origin never qualifies.
    if (parsed.protocol !== "https:" || parsed.port !== "") return null;
    return options.isPermitted(parsed.origin) ? parsed.origin : null;
  };

  const computeTuple = (): VisitTuple => {
    const chromeFrontmost = frontmostBundleId === chromeBundleId;
    if (focus === null) return { ...EMPTY_TUPLE, chromeFrontmost };
    const browserFocused = focus.browserFocused && focus.windowId !== WINDOW_ID_NONE;
    // Incognito pages never become visits; their URL is not kept.
    const url = focus.incognito === true ? null : (focus.url ?? null);
    return {
      chromeFrontmost,
      browserFocused,
      tabId: focus.tabId ?? null,
      documentId: focus.documentId ?? null,
      url,
      permittedOrigin: url === null ? null : permittedOrigin(url),
    };
  };

  /** Whether `next` keeps `held`: the same page, or Chrome showing no page at all (unfocused). */
  const keeps = (next: VisitTuple, held: ActiveVisit): boolean => {
    if (!options.isPermitted(held.origin)) return false;
    const showsPage = next.tabId !== null || next.url !== null || next.documentId !== null;
    if (!showsPage) return !next.browserFocused;
    return (
      next.tabId === held.tabId &&
      next.url === held.url &&
      next.permittedOrigin === held.origin &&
      next.documentId === (held.documentId ?? null)
    );
  };

  const setAway = (next: boolean): void => {
    if (visit === null || away === next) return;
    away = next;
    const presence = { epoch, away };
    options.diagnostics?.event(away ? "visit_suspended" : "visit_resumed", { epoch });
    try {
      options.onPresence?.(presence);
    } catch {
      options.diagnostics?.event("visit_change_handler_error", { epoch });
    }
  };

  const recompute = (force = false): void => {
    const next = computeTuple();
    if (visit !== null && !force && keeps(next, visit)) {
      tuple = next;
      setAway(!formsVisit(next));
      return;
    }
    if (visit === null && sameTuple(tuple, next)) return;
    tuple = next;
    epoch += 1;
    away = false;
    const previous = visit;
    visit = toVisit(next, epoch, options.clock.now(), getContextRevision());
    // Idle to idle (e.g. switching between unpermitted tabs) is not worth a log line.
    if (visit !== null || previous !== null) {
      options.diagnostics?.event("visit_change", { epoch, active: visit !== null });
    }
    try {
      options.onChange({ epoch, visit, previous });
    } catch {
      options.diagnostics?.event("visit_change_handler_error", { epoch });
    }
  };

  return {
    get epoch() {
      return epoch;
    },
    get away() {
      return away;
    },
    current: () => visit,
    observeFocus(obs) {
      focus = obs;
      recompute();
    },
    observeFrontmost(cmd) {
      frontmostBundleId = cmd.bundleId;
      recompute();
    },
    recompute: () => recompute(),
    reset() {
      focus = null;
      recompute(true);
    },
  };
}

function formsVisit(t: VisitTuple): boolean {
  return t.chromeFrontmost && t.browserFocused && t.tabId !== null && t.url !== null && t.permittedOrigin !== null;
}

function toVisit(t: VisitTuple, epoch: number, now: number, contextRevision: number): ActiveVisit | null {
  if (!formsVisit(t) || t.tabId === null || t.url === null || t.permittedOrigin === null) return null;
  const visit: ActiveVisit = {
    epoch,
    tabId: t.tabId,
    origin: t.permittedOrigin,
    url: t.url,
    startedAt: now,
    contextRevision,
  };
  if (t.documentId !== null) visit.documentId = t.documentId;
  return visit;
}

function sameTuple(a: VisitTuple, b: VisitTuple): boolean {
  return (
    a.chromeFrontmost === b.chromeFrontmost &&
    a.browserFocused === b.browserFocused &&
    a.tabId === b.tabId &&
    a.documentId === b.documentId &&
    a.url === b.url &&
    a.permittedOrigin === b.permittedOrigin
  );
}
