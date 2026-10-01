// Messages between the content script, the popup, and the background.
// Chrome-internal only; what leaves the extension is a @scout/contracts
// BrowserObservation.

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

export type PopupRequest =
  | { type: "popup-status" }
  | { type: "popup-pause"; paused: boolean }
  | { type: "popup-reconnect" }
  | { type: "popup-github-capture"; enabled: boolean };

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

/** Metadata-only status for the popup. Never carries page text or URLs. */
export interface StatusSnapshot {
  link: LinkState;
  paused: boolean;
  /** Exact-origin patterns Chrome has granted. */
  granted: string[];
  /** The popup's "Capture GitHub issue text" toggle, as it takes effect (off without the exact GitHub grant). */
  githubCapture: boolean;
  /** Chrome also holds a broad grant (e.g. all sites), which Scout ignores. */
  broadGrantIgnored: boolean;
  /** Null until the core sends a policy on the current port. */
  policy: PolicyState | null;
  counters: { focus: number; forwarded: number; dropped: number; acked: number; denied: number };
}
