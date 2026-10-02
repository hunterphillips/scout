// The one native port to `dev.scout.bridge`: connect, host messages, link
// health, link state for the popup, and manual reconnect. Reconnect timing is
// reconnect.ts; its series state is kept in chrome.storage.session so the
// bound survives MV3 worker restarts.
//
// A port counts as healthy only after the host says `ready` (core socket
// connected, the core answered hello with a capture_policy) or the core acks a
// page_text. Time alone never does. Each capture_policy goes to onPolicy; a
// new or lost port clears the policy, so capture starts disabled until the
// core sends one. A core_unavailable with reason upgrade_required is sticky
// until a later port is ready: mixed versions show as such, not as "down".
//
// Bridge protocol 3 carries Scout's window over the same port: each `panel` frame
// from the core (validated with ToChromeFrameSchema) goes to onPanel, and
// sendCommand posts a window command ({type:"command", command}) once the port is
// ready and the core is not reported unavailable. Commands are never queued: otherwise
// sendCommand returns false.

import { type CapturePolicy, CommandFrameSchema, type PanelState, type RelayCommand, ToChromeFrameSchema } from "@scout/contracts";
import { HOST_NAME } from "./hosts.js";
import type { LinkState } from "./messages.js";
import { type Clock, createReconnectPolicy, type ReconnectPolicy, type SeriesState, type SeriesStore } from "./reconnect.js";
import type { Counters, SharedState } from "./shared-state.js";

export const SERIES_KEY = "reconnectSeries";

export interface PortLink {
  readonly policy: ReconnectPolicy;
  /** Worker startup: resume or start the reconnect series. */
  start(): Promise<void>;
  /** Tab and focus events: may start one fresh series (the policy enforces the 60 s limit). */
  trigger(): void;
  /** The popup's Reconnect: drop any port and start a series now. */
  manualReconnect(): void;
  linkState(): LinkState;
  /**
   * Post one window command to the core. False (nothing sent) when the command is not a valid
   * relay command, no port is ready, or the host reports the core unavailable; never queued.
   */
  sendCommand(command: RelayCommand): boolean;
}

export interface PortDeps {
  ch: typeof chrome;
  clock: Clock;
  state: SharedState;
  counters: Counters;
  /** A new port is open (not yet ready). */
  onOpen(): void;
  /** The core sent a capture_policy on the current port. */
  onPolicy(policy: CapturePolicy): void;
  /** The port is gone: stop in-flight reads (bumps the cancel epoch). */
  onLost(): void;
  /** One of Scout's window frames from the core (protocol 3). Defaults to a no-op. */
  onPanel?(frame: PanelState): void;
}

const isSeries = (v: unknown): v is SeriesState => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["seriesStartedAt"] === "number" &&
    typeof s["step"] === "number" &&
    typeof s["exhausted"] === "boolean" &&
    (s["retryAt"] === null || typeof s["retryAt"] === "number")
  );
};

/** Series state in chrome.storage.session: cleared on browser restart, kept across worker restarts. */
export function sessionSeriesStore(ch: typeof chrome): SeriesStore {
  return {
    async load() {
      const area = ch.storage?.session;
      if (!area) return undefined;
      const r = await area.get(SERIES_KEY);
      const v = r?.[SERIES_KEY];
      return isSeries(v) ? v : undefined;
    },
    save(s) {
      Promise.resolve()
        .then(() => ch.storage?.session?.set({ [SERIES_KEY]: s }))
        .catch(() => {});
    },
  };
}

export function createPortLink(deps: PortDeps): PortLink {
  const { ch, clock, state, counters } = deps;
  let ready = false;
  let coreUnavailable = false;
  let upgradeRequired = false;

  const policy = createReconnectPolicy({ clock, attempt: () => connect(), store: sessionSeriesStore(ch) });

  function connect(): void {
    if (state.port) return;
    let p: chrome.runtime.Port;
    try {
      p = ch.runtime.connectNative(HOST_NAME);
    } catch {
      policy.disconnected(false);
      return;
    }
    state.port = p;
    state.policy = null;
    ready = false;
    coreUnavailable = false;
    p.onMessage.addListener((m: unknown) => onHostMessage(p, m));
    p.onDisconnect.addListener(() => {
      void ch.runtime.lastError; // read it so Chrome does not log it as unchecked
      if (state.port !== p) return;
      state.port = null;
      state.policy = null;
      const healthy = ready;
      deps.onLost();
      policy.disconnected(healthy);
    });
    deps.onOpen();
  }

  function onHostMessage(p: chrome.runtime.Port, m: unknown): void {
    if (state.port !== p) return;
    const parsed = ToChromeFrameSchema.safeParse(m);
    if (!parsed.success) return;
    switch (parsed.data.type) {
      case "core_unavailable":
        coreUnavailable = true;
        if (parsed.data.reason === "upgrade_required") upgradeRequired = true;
        break;
      case "ready":
        ready = true;
        coreUnavailable = false;
        upgradeRequired = false;
        break;
      case "capture_policy":
        deps.onPolicy(parsed.data);
        break;
      case "upgrade_required":
        break; // the host turns this into core_unavailable; never expected here
      case "panel":
        deps.onPanel?.(parsed.data.state);
        break;
      case "ack":
        ready = true;
        coreUnavailable = false;
        counters.acked++;
        break;
    }
  }

  function linkState(): LinkState {
    if (upgradeRequired) return "upgrade_required";
    if (state.port) {
      if (coreUnavailable) return "core_unavailable";
      return ready ? "connected" : "connecting";
    }
    return policy.pending ? "connecting" : "disconnected";
  }

  function trigger(): void {
    if (!state.port) policy.trigger();
  }

  function manualReconnect(): void {
    if (state.port) {
      const p = state.port;
      state.port = null; // our own disconnect() does not fire onDisconnect
      state.policy = null;
      try {
        p.disconnect();
      } catch {
        // already gone
      }
      deps.onLost();
    }
    policy.manual();
  }

  function sendCommand(command: RelayCommand): boolean {
    const p = state.port;
    // The host reports the core gone (it is retrying, or exiting): nothing would reach it.
    if (!p || !ready || coreUnavailable) return false;
    const frame = CommandFrameSchema.safeParse({ type: "command", command });
    if (!frame.success) return false;
    try {
      p.postMessage(frame.data);
      return true;
    } catch {
      return false;
    }
  }

  return { policy, start: () => policy.start(), trigger, manualReconnect, linkState, sendCommand };
}
