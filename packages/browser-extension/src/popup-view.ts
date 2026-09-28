// Popup rows from a status snapshot. Metadata only: states, hosts, counts.
import type { StatusSnapshot } from "./messages.js";

const LINK_TEXT: Record<StatusSnapshot["link"], string> = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "disconnected",
  core_unavailable: "core unavailable",
};

export function statusText(s: StatusSnapshot): string {
  return s.paused ? "paused" : LINK_TEXT[s.link];
}

export function hostLabel(pattern: string): string {
  return pattern.replace(/^https:\/\//, "").replace(/\/\*$/, "");
}

export function statusRows(s: StatusSnapshot): Array<[string, string]> {
  const c = s.counters;
  return [
    ["Status", statusText(s)],
    ["Granted sites", s.granted.length > 0 ? s.granted.map(hostLabel).join(", ") : "none"],
    ["Sent", `focus ${c.focus} · issues ${c.forwarded} · acked ${c.acked} · dropped ${c.dropped} · denied ${c.denied}`],
  ];
}
