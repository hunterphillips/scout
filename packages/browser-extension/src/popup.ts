// Popup. Shows the current tab's site (readable here through the activeTab
// grant that opening the popup gives), whether Scout may be allowed on it,
// and the button to allow or remove that one exact origin. Host access is
// requested ONLY from the Allow button's click (a user gesture), so
// chrome.permissions.request is the first statement in that handler. The
// activeTab grant is used for this local check only; nothing about the tab
// leaves the extension until the origin grant succeeds.
import { GITHUB_PATTERN } from "./hosts.js";
import type { PopupRequest, StatusSnapshot } from "./messages.js";
import { checkSite, REFUSAL_TEXT, type SiteVerdict } from "./origin.js";
import { statusRows } from "./popup-view.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The current tab's verdict; read once when the popup opens. */
let site: SiteVerdict = { ok: false, reason: "no-page" };
/** The exact-origin pattern the Allow and Remove buttons act on ("" when none). */
let sitePatternValue = "";

function renderSite(s: StatusSnapshot | undefined): void {
  const allow = $<HTMLButtonElement>("allow");
  const remove = $<HTMLButtonElement>("remove");
  if (!site.ok) {
    $("site-origin").textContent = "";
    $("site-verdict").textContent = REFUSAL_TEXT[site.reason];
    allow.hidden = true;
    remove.hidden = true;
    return;
  }
  const granted = s?.granted.includes(site.pattern) === true;
  $("site-origin").textContent = site.origin;
  $("site-verdict").textContent = granted ? "Scout is allowed on this site." : "Scout is not allowed on this site.";
  allow.hidden = granted;
  remove.hidden = !granted;
}

function render(s: StatusSnapshot | undefined): void {
  if (!s || !Array.isArray(s.granted)) return;
  renderSite(s);
  const dl = $("status");
  dl.replaceChildren();
  for (const [k, v] of statusRows(s)) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const capture = $<HTMLInputElement>("github-capture");
  capture.disabled = !s.granted.includes(GITHUB_PATTERN);
  capture.checked = s.githubCapture;
  const pause = $<HTMLButtonElement>("pause");
  pause.textContent = s.paused ? "Resume" : "Pause";
  pause.dataset["paused"] = String(s.paused);
}

const ask = (msg: PopupRequest): Promise<void> =>
  chrome.runtime.sendMessage(msg).then(
    (s: StatusSnapshot) => render(s),
    () => {},
  );

const refreshSoon = () => setTimeout(() => void ask({ type: "popup-status" }), 300);

$("allow").addEventListener("click", () => {
  chrome.permissions
    .request({ origins: [sitePatternValue] })
    .catch(() => false)
    .then(refreshSoon);
});
$("remove").addEventListener("click", () => {
  chrome.permissions
    .remove({ origins: [sitePatternValue] })
    .catch(() => false)
    .then(refreshSoon);
});
$("github-capture").addEventListener("change", () => void ask({ type: "popup-github-capture", enabled: $<HTMLInputElement>("github-capture").checked }));
$("pause").addEventListener("click", () => void ask({ type: "popup-pause", paused: $("pause").dataset["paused"] !== "true" }));
$("reconnect").addEventListener("click", () => void ask({ type: "popup-reconnect" }));

chrome.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then(
    ([t]) => checkSite(t?.url, t?.incognito === true),
    (): SiteVerdict => ({ ok: false, reason: "no-page" }),
  )
  .then((v) => {
    site = v;
    sitePatternValue = v.ok ? v.pattern : "";
    renderSite(undefined);
    return ask({ type: "popup-status" });
  });
setInterval(() => void ask({ type: "popup-status" }), 1000);
