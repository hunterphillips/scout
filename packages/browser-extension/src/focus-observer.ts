// Focus observations: debounced to one per burst of tab/window events, read
// from the browser-owned active tab, never sent while paused. Each carries the
// revision of the last permissions snapshot sent, and a tab's url and title
// only when its exact origin is in that snapshot: Chrome also exposes them
// under a temporary activeTab grant, which must not leave the extension.

import type { FocusObservation } from "@scout/contracts";
import { sitePattern } from "./origin.js";
import type { Clock } from "./reconnect.js";
import { activeTab, type Counters, post, type SharedState } from "./shared-state.js";

export const FOCUS_DEBOUNCE_MS = 150;

export interface FocusObserver {
  /** Emit one observation FOCUS_DEBOUNCE_MS after the last call. */
  schedule(): void;
  /** Emit one now, dropping any scheduled one (it would carry the same state). */
  flush(): Promise<void>;
  readFocus(): Promise<FocusObservation>;
  emitFocus(): Promise<void>;
}

export interface FocusDeps {
  ch: typeof chrome;
  clock: Clock;
  state: SharedState;
  counters: Counters;
  windowIdNone: number;
  /** Resolves once the stored paused flag is loaded. */
  loaded(): Promise<void>;
}

export function createFocusObserver(deps: FocusDeps): FocusObserver {
  const { ch, clock, state, counters, windowIdNone } = deps;
  let timer: unknown = null;

  function schedule(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      void emitFocus();
    }, FOCUS_DEBOUNCE_MS);
  }

  function flush(): Promise<void> {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    return emitFocus();
  }

  async function readFocus(): Promise<FocusObservation> {
    const base = (): Pick<FocusObservation, "kind" | "seq" | "at"> => ({ kind: "focus", seq: ++state.seq, at: clock.now() });
    if (!state.browserFocused) return { ...base(), browserFocused: false, windowId: windowIdNone, permissionsRevision: state.permissionsRevision };
    const t = await activeTab(ch).catch(() => null);
    // Stamped after the await: the snapshot this observation is checked against is the latest sent.
    const obs: FocusObservation = { ...base(), browserFocused: true, windowId: t?.windowId ?? windowIdNone, permissionsRevision: state.permissionsRevision };
    if (!t) return obs;
    if (Number.isInteger(t.id) && t.id !== undefined && t.id >= 0) obs.tabId = t.id;
    obs.incognito = t.incognito === true;
    // url/title only for an exact origin in the snapshot sent (and visible to Chrome's grant).
    const pattern = typeof t.url === "string" && !obs.incognito ? sitePattern(t.url) : null;
    if (pattern === null || !state.sentGranted.has(pattern)) return obs;
    obs.url = t.url!;
    if (typeof t.title === "string") obs.title = t.title;
    return obs;
  }

  async function emitFocus(): Promise<void> {
    await deps.loaded();
    if (state.paused) return;
    const obs = await readFocus();
    if (state.paused) return;
    if (post(state, obs)) counters.focus++;
  }

  return { schedule, flush, readFocus, emitFocus };
}
