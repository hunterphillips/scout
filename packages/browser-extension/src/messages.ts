// Messages between the content script, the side panel, and the background.
// Chrome-internal only; what leaves the extension is a @scout/contracts
// BrowserObservation or a relay command.

import type { PanelState, RelayCommand } from "@scout/contracts";

/** Content -> background: may this document read the issue now? */
export interface ApproveRequest {
  type: "approve";
  navCounter: number;
  /** location.href at request time. Checked against the browser-owned tab URL. */
  url: string;
}

export interface ApproveResponse {
  approved: boolean;
  reason?: DenialCode;
}

/** Content -> background: the settled issue text. */
export interface PageTextMessage {
  type: "page_text";
  navCounter: number;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export type ContentToBackground = ApproveRequest | PageTextMessage;

/** Background -> content. */
export type BackgroundToContent = { type: "refresh" } | { type: "cancel"; stop: boolean };

/** The side panel's runtime.Port to the worker. */
export const PANEL_PORT_NAME = "scout-panel";
/** How often the panel posts a heartbeat on its port (the plan allows at most 20 s). */
export const PANEL_HEARTBEAT_MS = 15_000;

/** What the side panel asks the worker; each gets one `reply` with the same id. */
export type PanelPortRequest =
  /** Reply: StatusSnapshot. */
  | { type: "status" }
  /** One control: the extension's own pause and the core's pause/resume. Reply: PauseReply. */
  | { type: "pause"; paused: boolean }
  /** Reply: StatusSnapshot. */
  | { type: "reconnect" }
  /** Reply: StatusSnapshot. */
  | { type: "github-capture"; enabled: boolean }
  /** The active tab of the panel's window. Reply: CurrentSite (panel/sites.ts). */
  | { type: "site"; windowId: number }
  /** A window command for the core, never queued. Reply: CommandReply. */
  | { type: "command"; command: RelayCommand };

export interface PauseReply {
  status: StatusSnapshot;
  /** The core's pause/resume went to a ready port. */
  written: boolean;
}

export interface CommandReply {
  written: boolean;
  /** Not a relay command at all: the panel marks it invalid and never resends it. */
  invalid?: true;
}

export type PanelToWorker =
  | { type: "hb" }
  /** The panel's own window (windows.getCurrent), sent on every connect once known: the toolbar toggle. */
  | { type: "window"; windowId: number }
  | { type: "request"; id: number; request: PanelPortRequest };

export type WorkerToPanel =
  | { type: "status"; status: StatusSnapshot }
  /** One of the core's window frames (repainted from the worker's cache when the panel connects). */
  | { type: "frame"; state: PanelState }
  | { type: "reply"; id: number; result: unknown }
  /** The toolbar was clicked (activeTab may now show a tab's URL): ask for the current site again. */
  | { type: "site-check" };

export type DenialCode =
  | "sender"
  | "route"
  | "paused"
  /** No current core capture_policy allows capture (none since connect, disabled, or paused by the core). */
  | "policy"
  | "permission"
  | "not-foreground"
  | "cancelled"
  | "bridge-disconnected";

export type LinkState = "connected" | "connecting" | "disconnected" | "core_unavailable" | "upgrade_required";

/** The latest capture_policy from the core on the current port. */
export interface PolicyState {
  revision: number;
  captureEnabled: boolean;
  paused: boolean;
}

/** Metadata-only status for the side panel. Never carries page text or URLs. */
export interface StatusSnapshot {
  link: LinkState;
  /** The core's latest capture_policy says paused (the extension keeps no pause of its own). */
  paused: boolean;
  /** Exact-origin patterns Chrome has granted. */
  granted: string[];
  /** The panel's "Capture GitHub issue text" toggle, as it takes effect (off without the exact GitHub grant). */
  githubCapture: boolean;
  /** Chrome also holds a broad grant (e.g. all sites), which Scout ignores. */
  broadGrantIgnored: boolean;
  /** Null until the core sends a policy on the current port. */
  policy: PolicyState | null;
  counters: { focus: number; forwarded: number; dropped: number; acked: number; denied: number };
}
