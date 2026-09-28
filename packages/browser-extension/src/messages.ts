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

/** Content -> background: this document left the issue route. */
export interface RouteMessage {
  type: "route";
  issue: false;
  navCounter: number;
}

export type ContentToBackground = ApproveRequest | PageTextMessage | RouteMessage;

/** Background -> content. */
export type BackgroundToContent = { type: "refresh" } | { type: "cancel"; stop: boolean };

export type PopupRequest = { type: "popup-status" } | { type: "popup-pause"; paused: boolean } | { type: "popup-reconnect" };

export type DenialCode =
  | "sender"
  | "route"
  | "paused"
  | "permission"
  | "not-foreground"
  | "cancelled"
  | "bridge-disconnected";

export type LinkState = "connected" | "connecting" | "disconnected" | "core_unavailable";

/** Metadata-only status for the popup. Never carries page text or URLs. */
export interface StatusSnapshot {
  link: LinkState;
  paused: boolean;
  granted: string[];
  counters: { focus: number; forwarded: number; dropped: number; acked: number; denied: number };
}
