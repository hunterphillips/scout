import type { ActiveVisit, FocusObservation, NativeCommand } from "@scout/contracts";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

export const CHROME_BUNDLE_ID = "com.google.Chrome";

/** chrome.windows.WINDOW_ID_NONE: no Chrome window has focus. */
export const WINDOW_ID_NONE = -1;

export interface VisitChange {
  epoch: number;
  /** null means idle: no approved page is in front. */
  visit: ActiveVisit | null;
  /** The visit this change replaces; null means the tracker was idle. idle to idle is possible. */
  previous: ActiveVisit | null;
}

export interface VisitTrackerOptions {
  /** Approved hostnames, e.g. "docs.stripe.com". Each must be a bare lowercase host; construction throws otherwise. */
  destinations: readonly string[];
  chromeBundleId?: string;
  clock: Clock;
  /**
   * Called synchronously on every real change, never on a duplicate. A throw is caught and
   * logged, never rethrown. Re-entry is not supported: the handler must not call
   * observeFocus or observeFrontmost.
   */
  onChange: (change: VisitChange) => void;
  /** Scout's current contextRevision, stamped on each new visit. */
  getContextRevision?: () => number;
  diagnostics?: Diagnostics;
}

export interface VisitTracker {
  observeFocus(obs: FocusObservation): void;
  observeFrontmost(cmd: Extract<NativeCommand, { type: "frontmost" }>): void;
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
  approvedOrigin: string | null;
}

const EMPTY_TUPLE: VisitTuple = {
  chromeFrontmost: false,
  browserFocused: false,
  tabId: null,
  documentId: null,
  url: null,
  approvedOrigin: null,
};

/**
 * Combines the latest `focus` observation with the latest `frontmost` command. Frontmost
 * is unknown (treated as not Chrome) until the first `frontmost` command arrives.
 */
export function createVisitTracker(options: VisitTrackerOptions): VisitTracker {
  const chromeBundleId = options.chromeBundleId ?? CHROME_BUNDLE_ID;
  for (const d of options.destinations) assertDestination(d);
  const approvedOrigins = new Set(options.destinations.map((d) => `https://${d}`));
  const getContextRevision = options.getContextRevision ?? (() => 0);

  let focus: FocusObservation | null = null;
  let frontmostBundleId: string | null = null;
  let tuple: VisitTuple = EMPTY_TUPLE;
  let epoch = 0;
  let visit: ActiveVisit | null = null;

  const approvedOrigin = (url: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    // Compare the full origin so a port-bearing origin (https://host:8443) is not approved.
    return approvedOrigins.has(parsed.origin) ? parsed.origin : null;
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
      approvedOrigin: url === null ? null : approvedOrigin(url),
    };
  };

  const recompute = (): void => {
    const next = computeTuple();
    if (sameTuple(tuple, next)) return;
    tuple = next;
    epoch += 1;
    const previous = visit;
    visit = toVisit(next, epoch, options.clock.now(), getContextRevision());
    // Idle to idle (e.g. switching between unapproved tabs) is not worth a log line.
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
  };
}

/** A destination must be a bare host as URL parsing would print it: no scheme, path, or uppercase. */
function assertDestination(d: string): void {
  let host: string | null = null;
  try {
    host = new URL(`https://${d}`).host;
  } catch {
    // Falls through to the throw below.
  }
  if (host !== d) throw new Error(`scout: invalid destination host ${JSON.stringify(d)}`);
}

function toVisit(t: VisitTuple, epoch: number, now: number, contextRevision: number): ActiveVisit | null {
  if (!t.chromeFrontmost || !t.browserFocused) return null;
  if (t.tabId === null || t.url === null || t.approvedOrigin === null) return null;
  const visit: ActiveVisit = {
    epoch,
    tabId: t.tabId,
    origin: t.approvedOrigin,
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
    a.approvedOrigin === b.approvedOrigin
  );
}
