// What a toolbar click does to the click's window's side panel (pure).
//
// Close only when this window's panel is known to be open and Chrome can close it
// (sidePanel.close, Chrome 141+); otherwise open, which is also what an older Chrome does.

export interface IconClickInput {
  /** A connected panel port has reported this window as its own. */
  panelOpenInWindow: boolean;
  /** chrome.sidePanel.close exists. */
  canClose: boolean;
}

export type IconClickAction = "open" | "close";

export function iconClickAction({ panelOpenInWindow, canClose }: IconClickInput): IconClickAction {
  return panelOpenInWindow && canClose ? "close" : "open";
}
