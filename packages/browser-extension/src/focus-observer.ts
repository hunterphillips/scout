// Focus observations: debounced to one per burst of tab/window events, read
// from the browser-owned active tab, never sent while paused.

import type { FocusObservation } from "@scout/contracts";
import type { Clock } from "./reconnect.js";
import { activeTab, type Counters, post, type SharedState } from "./shared-state.js";

export const FOCUS_DEBOUNCE_MS = 150;

export interface FocusObserver {
  /** Emit one observation FOCUS_DEBOUNCE_MS after the last call. */
  schedule(): void;
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

  async function readFocus(): Promise<FocusObservation> {
    if (!state.browserFocused) return { kind: "focus", seq: ++state.seq, at: clock.now(), browserFocused: false, windowId: windowIdNone };
    const t = await activeTab(ch).catch(() => null);
    const obs: FocusObservation = { kind: "focus", seq: ++state.seq, at: clock.now(), browserFocused: true, windowId: t?.windowId ?? windowIdNone };
    if (!t) return obs;
    if (Number.isInteger(t.id) && t.id !== undefined && t.id >= 0) obs.tabId = t.id;
    // Chrome only fills url/title for tabs whose host is granted. Absent means unapproved.
    if (typeof t.url === "string" && t.url !== "") obs.url = t.url;
    if (typeof t.title === "string" && obs.url !== undefined) obs.title = t.title;
    obs.incognito = t.incognito === true;
    return obs;
  }

  async function emitFocus(): Promise<void> {
    await deps.loaded();
    if (state.paused) return;
    const obs = await readFocus();
    if (state.paused) return;
    if (post(state, obs)) counters.focus++;
  }

  return { schedule, readFocus, emitFocus };
}
