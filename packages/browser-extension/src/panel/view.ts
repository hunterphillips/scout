// The side panel's DOM, rendered from the model, the worker's status and the current site.
// No `chrome.*`: every action goes to an injected handler, so the view runs under jsdom.
//
// Each change renders the whole panel into a detached tree, then patches the live one toward it
// (P4.4): an element is kept when its tag and `data-key` match (unkeyed siblings match by tag, in
// order), so its attributes and text are updated in place and an unchanged control is the same
// node across renders. Focus, scroll and a click in progress (mousedown, a frame, mouseup) all
// survive; focus and scroll are still restored by `data-key` for a node that was replaced.
// Events are delegated: the root holds one `click`, one `submit` and one `input` listener
// (installed once) that dispatch on `data-action` / `data-submit` / `data-input` to the latest
// render's handlers, so no listener is attached to any rendered node. (No `keydown` listener is
// needed: buttons and checkboxes turn Enter/Space into `click`, the site box submits its form;
// Escape is panel-app.ts's document listener.) Text from the core and from sites only ever goes
// in through textContent. Sections, in order: Results (default), Sites, This site, Settings,
// Activity, Problems; Escape returns to Results (panel-app.ts).

import type { StatusSnapshot } from "../messages.js";
import { hostOf } from "./capabilities.js";
import { ACK_CODE_TEXT, type PanelModel, type PanelSection, type Problem, SECTIONS } from "./model.js";
import { refusalText as linkRefusalText } from "./links.js";
import { failureText, type PreviewKey, sameKey } from "./preview.js";
import { displayExplanation } from "./results.js";
import { type CurrentSite, refusalText as siteRefusalText, siteRows, UNKNOWN_SITE_TEXT } from "./sites.js";

export interface PanelUi {
  /** The origin whose auto-acquire acknowledgement sheet is open. */
  ackSheet: string | null;
  /** What the user typed into Sites' "Allow another site" (kept across renders). */
  siteInput: string;
  siteInputError: string | null;
}

export interface ViewState {
  model: PanelModel;
  status: StatusSnapshot | null;
  site: CurrentSite;
  ui: PanelUi;
}

export interface PanelHandlers {
  select(section: PanelSection): void;
  open(candidateId: string): void;
  allow(pattern: string): void;
  remove(pattern: string): void;
  allowTyped(text: string): void;
  showPreview(key: PreviewKey): void;
  restartPreview(key: PreviewKey): void;
  closePreview(): void;
  approve(key: PreviewKey): void;
  decline(key: PreviewKey): void;
  revoke(resourceId: string): void;
  /** Turning on opens the acknowledgement sheet first; `acknowledged` is its confirm button. */
  autoAcquire(origin: string, enabled: boolean, acknowledged: boolean): void;
  cancelSheet(): void;
  grant(enabled: boolean): void;
  pause(): void;
  githubCapture(enabled: boolean): void;
  reconnect(): void;
  refresh(): void;
  retry(commandId: string): void;
  dismiss(commandId: string): void;
}

// ---------- status rows (the popup's, moved here) ----------

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

export const BROAD_GRANT_TEXT = "All-sites access is ignored; only sites allowed here count.";

export function statusRows(s: StatusSnapshot): Array<[string, string]> {
  const c = s.counters;
  return [
    ["Status", statusText(s)],
    ["Allowed sites", s.granted.length > 0 ? s.granted.map(hostLabel).join(", ") : "none"],
    ...(s.broadGrantIgnored ? [["Site access", BROAD_GRANT_TEXT] as [string, string]] : []),
    ["Issue text", captureText(s)],
    ["Sent", `focus ${c.focus} · issues ${c.forwarded} · acked ${c.acked} · dropped ${c.dropped} · denied ${c.denied}`],
  ];
}

// ---------- DOM helpers ----------

type Attrs = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;

function el(doc: Document, tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

// ---------- delegated events ----------

type Dispatch = (target: HTMLElement) => void;
interface Actions {
  click: Map<string, Dispatch>;
  submit: Map<string, Dispatch>;
  input: Map<string, Dispatch>;
}
/** The handlers of the render in progress (rendering is synchronous). */
let building: Actions | null = null;
/** Each root's latest handlers; the root's listeners read them at event time. */
const rootActions = new WeakMap<HTMLElement, Actions>();

function register(kind: keyof Actions, key: string, fn: Dispatch): void {
  building?.[kind].set(key, fn);
}

function installDelegation(root: HTMLElement): void {
  const dispatch = (kind: keyof Actions, attr: string, e: Event): boolean => {
    const t = (e.target as Element | null)?.closest?.(`[${attr}]`) as HTMLElement | null | undefined;
    if (!t || !root.contains(t)) return false;
    const fn = rootActions.get(root)?.[kind].get(t.getAttribute(attr)!);
    fn?.(t);
    return fn !== undefined;
  };
  root.addEventListener("click", (e) => void dispatch("click", "data-action", e));
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    dispatch("submit", "data-submit", e);
  });
  root.addEventListener("input", (e) => void dispatch("input", "data-input", e));
}

function button(doc: Document, key: string, label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  register("click", key, onClick);
  return el(doc, "button", { type: "button", "data-key": key, "data-action": key, ...attrs }, label) as HTMLButtonElement;
}

function checkbox(doc: Document, key: string, label: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void, note?: string): HTMLElement {
  // `click` fires after the box has flipped (pointer, Space, or its label), so `checked` is the new value.
  register("click", key, (t) => onChange((t as HTMLInputElement).checked));
  const input = el(doc, "input", { type: "checkbox", "data-key": key, "data-action": key, id: key, disabled: !enabled, checked }) as HTMLInputElement;
  return el(doc, "div", { class: "check" }, el(doc, "label", { for: key }, input, ` ${label}`), note ? el(doc, "p", { class: "note" }, note) : null);
}

const kindText = (k: string): string => (k === "llms_txt" ? "llms.txt" : k === "agents_md" ? "AGENTS.md" : k === "skill" ? "Skill" : k);
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
function bytesText(n: number): string {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}
/** The full resource id and version: a data-key is also the click dispatch key, so it must never collide. */
const keyOf = (k: PreviewKey): string => `${k.resourceId}-${k.version}`;

// ---------- sections ----------

function resultsSection(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const m = v.model;
  const d = m.resultsDisplay;
  const box = el(doc, "div", {}, el(doc, "p", { id: "results-explanation", class: `state state-${d.kind}`, text: displayExplanation(d) }));
  if (d.kind === "ready") {
    const list = el(doc, "ul", { class: "results", "aria-describedby": "results-explanation" });
    for (const item of d.items) {
      const rec = m.linkRecord(item.candidateId);
      const pending = rec?.state === "pending";
      const b = button(doc, `open-${item.candidateId}`, item.title, () => on.open(item.candidateId), {
        class: "link",
        "aria-label": `Open ${item.title} on ${item.hostname}`,
        disabled: pending || !m.running,
      });
      const failed = rec?.state === "failed" && rec.code ? el(doc, "p", { class: "error" }, `Couldn't open it: ${ACK_CODE_TEXT[rec.code]}. `, button(doc, `dismiss-${rec.id}`, "Dismiss", () => on.dismiss(rec.id))) : null;
      list.append(el(doc, "li", {}, b, el(doc, "p", { class: "reason", text: item.reason }), el(doc, "p", { class: "host", text: pending ? `${item.hostname} · opening…` : item.hostname }), failed));
    }
    box.append(list);
  }
  for (const r of m.resultsModel.linkRefusals) {
    box.append(el(doc, "p", { class: "error" }, `A link was not opened: ${linkRefusalText(r.refusal)}. `, button(doc, `dismiss-${r.commandId}`, "Dismiss", () => on.dismiss(r.commandId))));
  }
  return box;
}

function sitesSection(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const granted = v.status?.granted ?? [];
  const rows = siteRows(granted, v.model.capabilities.origins, v.model.capabilities.destinations);
  const box = el(doc, "div", {});
  if (rows.length === 0) box.append(el(doc, "p", { text: "No sites yet. Allow a site to let Scout see it." }));
  const list = el(doc, "ul", { class: "sites" });
  for (const r of rows) {
    const state = r.granted ? "Allowed" : "Not allowed";
    const extra = (r.recommendations ? " · Recommendations on" : "") + (r.autoAcquire ? " · gets resources automatically" : "");
    const action = r.pattern === null ? el(doc, "span", { class: "note", text: "Non-standard port" }) : r.granted
      ? button(doc, `remove-${r.host}`, "Remove", () => on.remove(r.pattern!), { "aria-label": `Remove ${r.host}` })
      : button(doc, `allow-${r.host}`, "Allow", () => on.allow(r.pattern!), { "aria-label": `Allow Scout on ${r.host}` });
    list.append(el(doc, "li", {}, el(doc, "span", { class: "site-host", text: r.host }), el(doc, "span", { class: "site-state", text: state + extra }), action));
  }
  box.append(list);
  register("input", "site-input", (t) => {
    v.ui.siteInput = (t as HTMLInputElement).value;
  });
  register("submit", "site-add", (form) => on.allowTyped(form.querySelector<HTMLInputElement>("#site-input")?.value ?? ""));
  const input = el(doc, "input", { type: "text", id: "site-input", "data-key": "site-input", "data-input": "site-input", placeholder: "docs.example.com", autocomplete: "off", spellcheck: "false", "aria-describedby": "site-input-note", value: v.ui.siteInput }) as HTMLInputElement;
  const form = el(doc, "form", { class: "add-site", "data-submit": "site-add" }, el(doc, "label", { for: "site-input", text: "Allow another site" }), el(doc, "div", { class: "row" }, input, el(doc, "button", { type: "submit", "data-key": "site-add", text: "Allow" })));
  box.append(form, el(doc, "p", { id: "site-input-note", class: v.ui.siteInputError ? "error" : "note", text: v.ui.siteInputError ?? "Chrome asks you to confirm each site." }));
  if (v.status?.broadGrantIgnored) box.append(el(doc, "p", { class: "note", text: BROAD_GRANT_TEXT }));
  box.append(el(doc, "p", { class: "note", text: "To turn recommendations on for a site, add it to destinations in Scout's config.json." }));
  return box;
}

function previewPane(doc: Document, v: ViewState, on: PanelHandlers, key: PreviewKey): HTMLElement {
  const m = v.model;
  const a = m.preview(key);
  const offer = m.capabilities.offer(key);
  const entry = m.capabilities.libraryEntry(key.resourceId);
  const desc = a?.descriptor;
  const kind = desc?.kind ?? offer?.kind ?? entry?.kind ?? "";
  const source = desc?.sourceUrl ?? offer?.sourceUrl ?? entry?.sourceUrl ?? "";
  const total = a?.totalBytes ?? offer?.byteLength ?? null;
  const blocker = m.approveBlocker(key);
  const phaseText =
    a === undefined ? "Not loaded." : a.phase === "complete" ? "Complete and verified." : a.phase === "failed" && a.failure ? `Couldn't load it: ${failureText(a.failure)}.` : `Loading… ${a.bytes.length}${total !== null ? ` of ${total}` : ""} bytes`;
  const k = keyOf(key);
  const pane = el(
    doc,
    "section",
    { class: "preview", "aria-label": "Preview", id: "preview-pane" },
    el(doc, "h3", { text: `${kindText(kind)} preview` }),
    el(
      doc,
      "dl",
      {},
      el(doc, "dt", { text: "Source" }),
      el(doc, "dd", { text: `${hostOf(source) ?? ""}${pathOf(source)}` }),
      el(doc, "dt", { text: "Size" }),
      el(doc, "dd", { text: total === null ? "unknown" : bytesText(total) }),
      desc?.skill ? el(doc, "dt", { text: "Skill" }) : null,
      desc?.skill ? el(doc, "dd", { text: desc.skill.name }) : null,
      el(doc, "dt", { text: "Status" }),
      el(doc, "dd", { text: phaseText }),
    ),
    el(doc, "pre", { class: "preview-text", tabindex: "0", "data-key": `preview-text-${k}`, "aria-label": "Resource text", text: a?.text ?? "" }),
    el(
      doc,
      "div",
      { class: "row" },
      button(doc, `approve-${k}`, "Approve", () => on.approve(key), { disabled: blocker !== null, "aria-describedby": "approve-note" }),
      m.canDecline(key) ? button(doc, `decline-${k}`, "Decline", () => on.decline(key)) : null,
      a?.phase === "failed" ? button(doc, `reload-${k}`, "Load again", () => on.restartPreview(key)) : null,
      button(doc, "preview-close", "Close preview", () => on.closePreview()),
    ),
    el(doc, "p", { id: "approve-note", class: "note", text: blocker ?? "Approving lets your agent read this version." }),
  );
  return pane;
}

function thisSiteSection(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const m = v.model;
  const box = el(doc, "div", {});
  const s = v.site;
  let host: string | null = null;
  if (s.kind === "none") box.append(el(doc, "p", { text: "No tab is open in this window." }));
  else if (s.kind === "unknown") box.append(el(doc, "p", { id: "site-unknown", text: UNKNOWN_SITE_TEXT }));
  else if (s.kind === "refused") box.append(el(doc, "p", { text: siteRefusalText(s.reason) }));
  else {
    const granted = v.status?.granted.includes(s.pattern) === true;
    box.append(el(doc, "p", { class: "site-host", text: s.host }));
    if (granted) {
      host = s.host;
      box.append(el(doc, "p", { text: "Scout is allowed on this site." }), button(doc, "site-remove", "Remove this site", () => on.remove(s.pattern)));
    } else {
      box.append(el(doc, "p", { text: "Scout is not allowed on this site." }), button(doc, "site-allow", "Allow Scout on this site", () => on.allow(s.pattern)));
    }
  }
  if (host !== null && s.kind === "ok") {
    if (!m.running) box.append(el(doc, "p", { class: "note", text: "Connect to Scout to see what this site offers." }));
    else if (m.missingCapabilities) box.append(el(doc, "p", { class: "note", text: "Scout core's list of offers didn't arrive." }));
    else {
      const offers = m.capabilities.offersForHost(host);
      box.append(el(doc, "h3", { text: "Offers" }));
      if (offers.length === 0) box.append(el(doc, "p", { class: "note", text: "Nothing new to review on this site." }));
      const ol = el(doc, "ul", { class: "offers" });
      for (const o of offers) {
        const key = { resourceId: o.resourceId, version: o.version };
        const k = keyOf(key);
        const name = o.skill ? `${kindText(o.kind)} “${o.skill.name}”` : kindText(o.kind);
        const rec = m.decisionRecord(key);
        ol.append(
          el(
            doc,
            "li",
            {},
            el(doc, "span", { class: "offer-name", text: name }),
            el(doc, "span", { class: "note", text: `${pathOf(o.sourceUrl)} · ${bytesText(o.byteLength)}` }),
            el(
              doc,
              "div",
              { class: "row" },
              button(doc, `preview-${k}`, "Preview", () => on.showPreview(key), { "aria-label": `Preview ${name}`, "aria-pressed": sameKey(m.shownPreview, key) ? "true" : "false" }),
              button(doc, `decline-offer-${k}`, "Decline", () => on.decline(key), { "aria-label": `Decline ${name}`, disabled: !m.canDecline(key) }),
              rec?.state === "pending" ? el(doc, "span", { class: "note", text: "Waiting for Scout core…" }) : null,
            ),
          ),
        );
      }
      box.append(ol);
      const library = m.capabilities.libraryForHost(host);
      box.append(el(doc, "h3", { text: "Approved for your agent" }));
      if (library.length === 0) box.append(el(doc, "p", { class: "note", text: "Nothing from this site yet." }));
      const ll = el(doc, "ul", { class: "library" });
      for (const e of library) {
        const stateText = e.state === "approved" ? "Approved" : e.state === "blocked" ? "Revoked" : "Not approved";
        const newest = e.versions[0];
        const reapprove = e.state !== "approved" && newest ? { resourceId: e.resourceId, version: newest.hash } : null;
        ll.append(
          el(
            doc,
            "li",
            {},
            el(doc, "span", { class: "offer-name", text: kindText(e.kind) }),
            el(doc, "span", { class: "note", text: `${pathOf(e.sourceUrl)} · ${stateText}` }),
            el(
              doc,
              "div",
              { class: "row" },
              m.canRevoke(e.resourceId) ? button(doc, `revoke-${e.resourceId}`, "Revoke", () => on.revoke(e.resourceId), { "aria-label": `Revoke ${kindText(e.kind)}` }) : null,
              reapprove ? button(doc, `library-preview-${keyOf(reapprove)}`, "Preview", () => on.showPreview(reapprove), { "aria-label": `Preview ${kindText(e.kind)}` }) : null,
            ),
          ),
        );
      }
      box.append(ll);
      const setting = m.capabilities.originSetting(s.origin);
      if (setting) {
        const rec = m.autoAcquireRecord(s.origin);
        box.append(
          checkbox(doc, "auto-acquire", "Get this site's resources automatically", setting.autoAcquire, m.canToggleAutoAcquire(s.origin), (on2) => on.autoAcquire(s.origin, on2, false), rec?.state === "pending" ? "Waiting for Scout core…" : "New versions are approved without a preview."),
        );
        if (v.ui.ackSheet === s.origin) {
          box.append(
            el(
              doc,
              "div",
              { class: "sheet", role: "dialog", "aria-modal": "false", "aria-labelledby": "sheet-title" },
              el(doc, "h3", { id: "sheet-title", text: "Approve this site's resources without asking?" }),
              el(doc, "p", { text: `Scout will approve every new llms.txt, AGENTS.md and skill from ${s.host} for your agent without showing you a preview first. A site can change these files at any time.` }),
              el(doc, "div", { class: "row" }, button(doc, "sheet-confirm", "Turn on", () => on.autoAcquire(s.origin, true, true)), button(doc, "sheet-cancel", "Cancel", () => on.cancelSheet())),
            ),
          );
        }
      }
    }
  }
  if (m.shownPreview) box.append(previewPane(doc, v, on, m.shownPreview));
  return box;
}

function settingsSection(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const m = v.model;
  const c = m.pauseState.control;
  const box = el(doc, "div", {}, el(doc, "div", { class: "row" }, button(doc, "pause", c.title, () => on.pause(), { disabled: !c.enabled, "aria-label": c.label })));
  const gh = v.status?.granted.includes("https://github.com/*") === true;
  box.append(checkbox(doc, "github-capture", "Capture GitHub issue text", v.status?.githubCapture === true, gh, (x) => on.githubCapture(x), gh ? undefined : "Allow github.com in Sites first."));
  const grant = m.capabilities.agentBrowserContext;
  const grec = m.grantRecord;
  box.append(
    checkbox(
      doc,
      "agent-context",
      "Let your agent read the current site and recent GitHub issues",
      grant === true,
      m.canToggleGrant,
      (x) => on.grant(x),
      grec?.state === "pending" ? "Waiting for Scout core…" : grant === null ? "Waiting for Scout core." : undefined,
    ),
  );
  box.append(el(doc, "div", { class: "row" }, button(doc, "refresh", "Refresh offers", () => on.refresh(), { disabled: !m.running }), button(doc, "reconnect", "Reconnect", () => on.reconnect())));
  if (v.status) {
    const dl = el(doc, "dl", { class: "status" });
    for (const [k, val] of statusRows(v.status)) dl.append(el(doc, "dt", { text: k }), el(doc, "dd", { text: val }));
    box.append(dl);
  }
  return box;
}

function activitySection(doc: Document, v: ViewState): HTMLElement {
  const entries = [...v.model.capabilities.audit].reverse();
  const box = el(doc, "div", {}, el(doc, "p", { class: "note", text: "What your agent read through Scout, newest first. Never the text itself." }));
  if (entries.length === 0) box.append(el(doc, "p", { text: "No reads yet." }));
  const list = el(doc, "ul", { class: "activity" });
  for (const e of entries) {
    const when = new Date(e.at).toLocaleTimeString();
    const who = e.role === "job" ? "Background job" : "Your agent";
    list.append(el(doc, "li", { text: `${when} · ${who} · ${e.method.replace(/_/g, " ")} · ${e.outcome.replace(/_/g, " ")}${e.origin ? ` · ${hostOf(e.origin) ?? e.origin}` : ""}` }));
  }
  box.append(list);
  return box;
}

const REQUEST_TEXT: Record<string, string> = {
  approve: "Approve",
  decline: "Decline",
  revoke: "Revoke",
  set_auto_acquire: "Auto-acquire",
  set_agent_browser_context: "Agent access",
  refresh_capabilities: "Refresh",
  open_link: "Open link",
};

function problemsSection(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const m = v.model;
  const problems = m.problems;
  const box = el(doc, "div", {});
  if (problems.length === 0) box.append(el(doc, "p", { text: "No problems." }));
  const list = el(doc, "ul", { class: "problems" });
  problems.forEach((p: Problem, i) => {
    if (p.kind === "link") list.append(el(doc, "li", { text: p.text }));
    else if (p.kind === "conflict") list.append(el(doc, "li", { text: `Skill ${p.conflict.name} was left alone (${p.conflict.code.replace(/_/g, " ")}).` }));
    else if (p.kind === "preview") list.append(el(doc, "li", {}, `A preview failed: ${failureText(p.failure)}. `, button(doc, `problem-reload-${i}`, "Load again", () => on.restartPreview(p.key))));
    else if (p.kind === "linkRefused") list.append(el(doc, "li", {}, `A link was not opened: ${linkRefusalText(p.refusal)}. `, button(doc, `problem-dismiss-${p.commandId}`, "Dismiss", () => on.dismiss(p.commandId))));
    else {
      const r = p.record;
      const what = REQUEST_TEXT[r.request.type] ?? r.request.type;
      list.append(
        el(
          doc,
          "li",
          {},
          `${what} failed: ${r.code ? ACK_CODE_TEXT[r.code] : "unknown"}. `,
          m.canRetry(r.id) ? button(doc, `problem-retry-${r.id}`, "Retry", () => on.retry(r.id)) : null,
          button(doc, `problem-dismiss-${r.id}`, "Dismiss", () => on.dismiss(r.id)),
        ),
      );
    }
  });
  box.append(list);
  return box;
}

// ---------- the keyed patch ----------

const keyOfNode = (n: Node): string | null => (n.nodeType === 1 ? (n as Element).getAttribute("data-key") : null);

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return (a as Element).tagName === (b as Element).tagName && keyOfNode(a) === keyOfNode(b);
}

/** Make `cur` (live) match `next` (detached) in place: attributes, form state, children. */
function patchNode(cur: Node, next: Node): void {
  if (cur.nodeType !== 1) {
    if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
    return;
  }
  const c = cur as Element;
  const n = next as Element;
  for (const { name } of [...c.attributes]) if (!n.hasAttribute(name)) c.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (c.getAttribute(name) !== value) c.setAttribute(name, value);
  if (c.tagName === "INPUT") {
    const ci = c as HTMLInputElement;
    // The model decides: a checkbox the user flipped shows the model's value until the core answers.
    if (ci.type === "checkbox") ci.checked = n.hasAttribute("checked");
    else if (ci.value !== (n.getAttribute("value") ?? "")) ci.value = n.getAttribute("value") ?? "";
  }
  patchChildren(c, n);
}

/** Reuse each live child that matches by tag and `data-key` (unkeyed: the first unused of its kind), in `next`'s order. */
function patchChildren(parent: Element, nextParent: Element): void {
  const nextKids = [...nextParent.childNodes];
  const curKids = [...parent.childNodes];
  const keyed = new Map<string, Node>();
  for (const k of curKids) {
    const key = keyOfNode(k);
    if (key !== null && !keyed.has(key)) keyed.set(key, k);
  }
  const used = new Set<Node>();
  nextKids.forEach((n, i) => {
    const key = keyOfNode(n);
    let match: Node | undefined = key !== null ? keyed.get(key) : curKids.find((k) => !used.has(k) && keyOfNode(k) === null && sameKind(k, n));
    if (match !== undefined && (used.has(match) || !sameKind(match, n))) match = undefined;
    let node: Node = n;
    if (match !== undefined) {
      used.add(match);
      patchNode(match, n);
      node = match;
    }
    if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] ?? null);
  });
  while (parent.childNodes.length > nextKids.length) parent.lastChild!.remove();
}

// ---------- the panel ----------

/** Renders the panel into `root` by a keyed patch (see the header), with delegated events. */
export function renderPanel(doc: Document, root: HTMLElement, v: ViewState, on: PanelHandlers): void {
  if (!rootActions.has(root)) installDelegation(root);
  const actions: Actions = { click: new Map(), submit: new Map(), input: new Map() };
  building = actions;
  try {
    build(doc, root, v, on);
  } finally {
    building = null;
  }
  rootActions.set(root, actions);
}

function build(doc: Document, root: HTMLElement, v: ViewState, on: PanelHandlers): void {
  const active = doc.activeElement as HTMLElement | null;
  const focusKey = active && root.contains(active) ? active.getAttribute("data-key") : null;
  const InputCtor = doc.defaultView!.HTMLInputElement;
  const caret =
    active instanceof InputCtor && active.type === "text" ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection ?? undefined } : null;
  const scroll = new Map<string, number>();
  for (const e of root.querySelectorAll<HTMLElement>("[data-key]")) if (e.scrollTop) scroll.set(e.getAttribute("data-key")!, e.scrollTop);

  const m = v.model;
  const problems = m.problems.length;
  const nav = el(doc, "nav", { "aria-label": "Scout sections" });
  for (const s of SECTIONS) {
    const label = s.id === "problems" && problems > 0 ? `${s.title} (${problems})` : s.title;
    nav.append(button(doc, `nav-${s.id}`, label, () => on.select(s.id), { "aria-current": m.section === s.id ? "page" : undefined, "aria-controls": "section" }));
  }
  const title = SECTIONS.find((s) => s.id === m.section)!.title;
  const body =
    m.section === "results"
      ? resultsSection(doc, v, on)
      : m.section === "sites"
        ? sitesSection(doc, v, on)
        : m.section === "site"
          ? thisSiteSection(doc, v, on)
          : m.section === "settings"
            ? settingsSection(doc, v, on)
            : m.section === "activity"
              ? activitySection(doc, v)
              : problemsSection(doc, v, on);
  // The header line lives outside `root` (panel.html) so its live region is not re-created.
  const header = doc.getElementById("header-line");
  if (header && header.textContent !== m.headerLine) header.textContent = m.headerLine;
  const next = el(doc, "div", {}, nav, el(doc, "section", { id: "section", "aria-labelledby": "section-title" }, el(doc, "h2", { id: "section-title", text: title }), body));
  patchChildren(root, next);

  // A kept node keeps its scroll and focus; these restore them on a node that was replaced.
  for (const [k, top] of scroll) {
    const e = root.querySelector<HTMLElement>(`[data-key="${k}"]`);
    if (e && e.scrollTop !== top) e.scrollTop = top;
  }
  // A focused node that was replaced, or moved by insertBefore (which blurs it), gets its focus
  // and its whole selection (start, end, direction) back.
  if (focusKey) {
    const e = root.querySelector<HTMLElement>(`[data-key="${focusKey}"]`);
    if (e && doc.activeElement !== e) e.focus();
    if (e instanceof InputCtor && caret && caret.start !== null && caret.end !== null && (e.selectionStart !== caret.start || e.selectionEnd !== caret.end)) {
      e.setSelectionRange(caret.start, caret.end, caret.direction);
    }
  }
}
