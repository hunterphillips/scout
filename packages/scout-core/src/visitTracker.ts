// Turns Chrome focus plus the Mac's frontmost app into the current visit: a permitted
// https page in the focused Chrome window while Chrome is frontmost. "Permitted" means the
// live connection's permissions snapshot grants the page's exact origin (injected as
// `isPermitted`); whether recommendations are enabled for that origin is a separate
// setting this tracker does not read. Every real change of the visit tuple is a new epoch.

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
  /** Scout's current contextRevision, stamped on each new visit. */
  getContextRevision?: () => number;
  diagnostics?: Diagnostics;
}

export interface VisitTracker {
  observeFocus(obs: FocusObservation): void;
  observeFrontmost(cmd: Extract<NativeCommand, { type: "frontmost" }>): void;
  /** Re-check the tuple against `isPermitted` (the permissions snapshot changed). Losing the current origin ends the visit. */
  recompute(): void;
  current(): ActiveVisit | null;
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

  const recompute = (): void => {
    const next = computeTuple();
    if (sameTuple(tuple, next)) return;
    tuple = next;
    epoch += 1;
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
    current: () => visit,
    observeFocus(obs) {
      focus = obs;
      recompute();
    },
    observeFrontmost(cmd) {
      frontmostBundleId = cmd.bundleId;
      recompute();
    },
    recompute,
  };
}

function toVisit(t: VisitTuple, epoch: number, now: number, contextRevision: number): ActiveVisit | null {
  if (!t.chromeFrontmost || !t.browserFocused) return null;
  if (t.tabId === null || t.url === null || t.permittedOrigin === null) return null;
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
