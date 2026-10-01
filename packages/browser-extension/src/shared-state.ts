// State and helpers shared by the background's parts (port, focus observer,
// page-text gate). One mutable object, owned by background-core.ts, so each
// part can be built and tested on its own.

import type { BrowserObservation } from "@scout/contracts";
import type { PolicyState, StatusSnapshot } from "./messages.js";
import type { Clock } from "./reconnect.js";

export interface SharedState {
  /** Bumped by pause, revoke, tab change, focus loss and port loss; async work re-checks it after every await. */
  cancelEpoch: number;
  paused: boolean;
  browserFocused: boolean;
  port: chrome.runtime.Port | null;
  /** Last observation seq used. Seeded from the clock so a worker restart never goes backwards. */
  seq: number;
  /** The GitHub-capture toggle (persisted in chrome.storage.local; false when storage fails). */
  githubCapture: boolean;
  /**
   * The latest core capture_policy on the current port; null from connect (and
   * after port loss) until the core sends one. Nothing is posted while null.
   */
  policy: PolicyState | null;
  /** Revision of the last permissions snapshot sent. Seeded from the clock like seq. */
  permissionsRevision: number;
  /** Origins in the last snapshot sent: a focus carries a URL only for one of these. */
  sentGranted: ReadonlySet<string>;
}

export type Counters = StatusSnapshot["counters"];

export function createSharedState(clock: Clock): SharedState {
  const seed = Math.max(0, Math.floor(clock.now()));
  return {
    cancelEpoch: 0,
    paused: false,
    browserFocused: true,
    port: null,
    seq: seed,
    githubCapture: false,
    policy: null,
    permissionsRevision: seed,
    sentGranted: new Set(),
  };
}

/** The core's current policy lets the extension capture page text. */
export const policyAllowsCapture = (state: SharedState): boolean =>
  state.policy !== null && state.policy.captureEnabled && !state.policy.paused;

export const newCounters = (): Counters => ({ focus: 0, forwarded: 0, dropped: 0, acked: 0, denied: 0 });

export const defaultClock = (): Clock => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
});

/**
 * Post one observation on the open port. False when there is none, it is gone,
 * or the core has not sent a policy on it yet (nothing leaves before that).
 */
export function post(state: SharedState, obs: BrowserObservation): boolean {
  if (!state.port || !state.policy) return false;
  try {
    state.port.postMessage(obs);
    return true;
  } catch {
    return false;
  }
}

export async function activeTab(ch: typeof chrome): Promise<chrome.tabs.Tab | null> {
  const [t] = await ch.tabs.query({ active: true, lastFocusedWindow: true });
  return t ?? null;
}
