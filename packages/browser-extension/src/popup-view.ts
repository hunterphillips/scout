// Popup rows from a status snapshot. Metadata only: states, hosts, counts.
import type { StatusSnapshot } from "./messages.js";

const LINK_TEXT: Record<StatusSnapshot["link"], string> = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "disconnected",
  core_unavailable: "core unavailable",
  upgrade_required: "update needed (Scout versions differ)",
};

export function statusText(s: StatusSnapshot): string {
  return s.paused ? "paused" : LINK_TEXT[s.link];
}

export function hostLabel(pattern: string): string {
  return pattern.replace(/^https:\/\//, "").replace(/\/\*$/, "");
}

/** What happens to GitHub issue text right now. */
export function captureText(s: StatusSnapshot): string {
  if (!s.githubCapture) return "off";
  if (s.policy === null) return "waiting for Scout";
  if (s.policy.paused) return "paused by Scout";
  return s.policy.captureEnabled ? "on" : "waiting for Scout";
}

export function statusRows(s: StatusSnapshot): Array<[string, string]> {
  const c = s.counters;
  return [
    ["Status", statusText(s)],
    ["Allowed sites", s.granted.length > 0 ? s.granted.map(hostLabel).join(", ") : "none"],
    ["Issue text", captureText(s)],
    ["Sent", `focus ${c.focus} · issues ${c.forwarded} · acked ${c.acked} · dropped ${c.dropped} · denied ${c.denied}`],
  ];
}
