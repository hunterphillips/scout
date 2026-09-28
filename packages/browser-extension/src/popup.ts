// Popup. Host access is requested ONLY from the Grant button's click (a user
// gesture), so chrome.permissions.request is the first call in that handler.
import { OPTIONAL_HOSTS } from "./hosts.js";
import type { PopupRequest, StatusSnapshot } from "./messages.js";
import { statusRows } from "./popup-view.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function render(s: StatusSnapshot | undefined): void {
  if (!s || !Array.isArray(s.granted)) return;
  const dl = $("status");
  dl.replaceChildren();
  for (const [k, v] of statusRows(s)) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $<HTMLButtonElement>("grant").disabled = OPTIONAL_HOSTS.every((h) => s.granted.includes(h));
  const pause = $<HTMLButtonElement>("pause");
  pause.textContent = s.paused ? "Resume" : "Pause";
  pause.dataset["paused"] = String(s.paused);
}

const ask = (msg: PopupRequest): Promise<void> =>
  chrome.runtime.sendMessage(msg).then(
    (s: StatusSnapshot) => render(s),
    () => {},
  );

$("grant").addEventListener("click", () => {
  chrome.permissions
    .request({ origins: [...OPTIONAL_HOSTS] })
    .catch(() => false)
    .then(() => setTimeout(() => void ask({ type: "popup-status" }), 300));
});
$("pause").addEventListener("click", () => void ask({ type: "popup-pause", paused: $("pause").dataset["paused"] !== "true" }));
$("reconnect").addEventListener("click", () => void ask({ type: "popup-reconnect" }));

void ask({ type: "popup-status" });
setInterval(() => void ask({ type: "popup-status" }), 1000);
