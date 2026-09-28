// Scout Phase 0 GitHub capture spike: popup rows from a status snapshot.
// Metadata ONLY: states, counts, lengths, selector ids, timings. The status
// object never carries captured text or URLs, and this view never adds any.

import { DENIAL_CODES } from "./background-core.mjs";

const fmtAge = (at, now) => (typeof at === "number" ? `${Math.max(0, Math.round((now - at) / 1000))}s ago` : "");

export function statusRows(s, now = Date.now()) {
  const b = s.bridge ?? {};
  const bridge =
    b.host === "connected" && b.server === "connected"
      ? "connected"
      : b.host === "host-missing"
        ? "disconnected (native host not installed)"
        : b.host !== "connected"
          ? `disconnected (host ${b.host ?? "?"})`
          : `disconnected (server ${b.server ?? "?"})`;
  const retry = b.waitingForTrigger ? "waiting for tab/focus or Reconnect" : Number.isFinite(b.retryInMs) ? `retry in ${Math.round(b.retryInMs / 1000)}s` : "";
  const rows = [
    ["Bridge", bridge],
    ["Retry", retry],
    ["GitHub access", s.permission === "granted" ? "granted" : "not granted"],
    ["Capture", s.paused ? "paused" : "on"],
    ["Page", s.current ? `${s.current.route} ${fmtAge(s.current.at, now)}` : ""],
  ];
  const c = s.lastCapture;
  if (c) {
    rows.push(["Last capture", `${c.state}${c.reason ? ` (${c.reason})` : ""}${c.acked ? ", acked" : ""} ${fmtAge(c.at, now)}`]);
    if (Number.isFinite(c.titleChars)) rows.push(["Title length", `${c.titleChars} chars${c.titleTruncated ? " (truncated)" : ""}`]);
    if (Number.isFinite(c.bodyBytes)) rows.push(["Body length", `${c.bodyBytes} bytes${c.bodyTruncated ? " (truncated)" : ""}`]);
    if (Number.isFinite(c.settleMs)) rows.push(["Settle", `${c.settleMs} ms`]);
    if (Array.isArray(c.selectorIds)) rows.push(["Selectors", c.selectorIds.join(", ")]);
  }
  const d = s.lastDenial;
  if (d) rows.push(["Last denial", `${DENIAL_CODES.has(d.reason) ? d.reason : "other"} ${fmtAge(d.at, now)}`.trim()]);
  const n = s.counters ?? {};
  rows.push(["Counts", `approved ${n.approved ?? 0} · denied ${n.denied ?? 0} · forwarded ${n.forwarded ?? 0} · acked ${n.acked ?? 0} · dropped ${n.dropped ?? 0} · rejected ${n.rejected ?? 0}`]);
  return rows.filter(([, v]) => v !== "");
}
