// Scout Phase 0 GitHub capture spike: popup. GitHub access is requested ONLY
// from the Grant button's click (a user gesture).
import { statusRows } from "./popup-view.mjs";

const ORIGINS = ["https://github.com/*"];
const $ = (id) => document.getElementById(id);

function render(s) {
  const dl = $("status");
  dl.replaceChildren();
  for (const [k, v] of statusRows(s)) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $("grant").disabled = s.permission === "granted";
  $("pause").textContent = s.paused ? "Resume" : "Pause";
  $("pause").dataset.paused = String(!!s.paused);
}

const ask = (msg) => chrome.runtime.sendMessage(msg).then(render, () => {});

$("grant").addEventListener("click", async () => {
  await chrome.permissions.request({ origins: ORIGINS }).catch(() => false);
  setTimeout(() => ask({ type: "popup-status" }), 300);
});
$("pause").addEventListener("click", () => ask({ type: "popup-pause", paused: $("pause").dataset.paused !== "true" }));
$("reconnect").addEventListener("click", () => ask({ type: "popup-reconnect" }));

ask({ type: "popup-status" });
setInterval(() => ask({ type: "popup-status" }), 1000);
