// The side panel's DOM, rendered from the model, the worker's status and the current site.
// No `chrome.*`: every action goes to an injected handler, so the view runs under jsdom.
//
// Each change renders the whole panel into a detached tree, then patches the live one toward it:
// an element is kept when its tag and `data-key` match (unkeyed siblings match by tag, in
// order), so its attributes and text are updated in place and an unchanged control is the same
// node across renders. Focus, scroll and a click in progress (mousedown, a frame, mouseup) all
// survive; focus and scroll are still restored by `data-key` for a node that was replaced.
// Events are delegated: the root holds one `click`, one `submit` and one `input` listener
// (installed once) that dispatch on `data-action` / `data-submit` / `data-input` to the latest
// render's handlers, so no listener is attached to any rendered node. (No `keydown` listener is
// needed: buttons and checkboxes turn Enter/Space into `click`, the site box submits its form;
// Escape is panel-app.ts's document listener.) Text from the core and from sites only ever goes
// in through textContent; icons are SVG built with createElementNS, never parsed markup.
//
// Layout (the "Quiet" design): a header with the mark and Pause/Resume, the current view,
// and a bottom pill nav with four destinations: Page (default), Sites, Activity, Settings.
// Page is bottom-aligned: the results (heading, one line, up to three link cards), the site's
// files for the user's agent (a pill that expands into the review card), what is approved, then
// a tray with the agent-context chip and the site's "Suggest on <host>" switch or Allow row.
// Activity holds Problems at the top; Settings holds the switches, the agent choice, Pause, Reconnect and a
// Diagnostics disclosure (which ends with the "Sent to Scout" counters). Escape collapses the review card, then returns to Page (panel-app.ts).

import type { CapabilityOffer, LibraryEntry } from "@scout/contracts";
import type { StatusSnapshot } from "../messages.js";
import { hostOf } from "./capabilities.js";
import { ACK_CODE_TEXT, type PanelModel, type PanelSection, type Problem, SECTIONS } from "./model.js";
import { refusalText as linkRefusalText } from "./links.js";
import { failureText, type PreviewKey, sameKey } from "./preview.js";
import { displayExplanation, displayHeading } from "./results.js";
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
  /** The site's background recommendations switch (`origin` is `https://host`). */
  destination(origin: string, enabled: boolean): void;
  /** Settings' agent choice: run background jobs through adapter `id`. */
  agent(id: string): void;
  pause(): void;
  githubCapture(enabled: boolean): void;
  reconnect(): void;
  refresh(): void;
  retry(commandId: string): void;
  dismiss(commandId: string): void;
}

// ---------- status rows (Settings' Diagnostics) ----------

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

export const BROAD_GRANT_TEXT = "Scout ignores Chrome's all-sites access. It works only on sites you allow here.";

export function statusRows(s: StatusSnapshot): Array<[string, string]> {
  return [
    ["Status", statusText(s)],
    ["Allowed sites", s.granted.length > 0 ? s.granted.map(hostLabel).join(", ") : "none"],
    ...(s.broadGrantIgnored ? [["Site access", BROAD_GRANT_TEXT] as [string, string]] : []),
    ["Issue text", captureText(s)],
  ];
}

/** Diagnostics' "Sent to Scout" row: what the extension has sent Scout (metadata counts only). */
export function sentText(s: StatusSnapshot): string {
  const c = s.counters;
  return `tab updates ${c.focus} · issues ${c.forwarded} · received ${c.acked} · dropped ${c.dropped} · blocked ${c.denied}`;
}

// ---------- names ----------

const kindText = (k: string): string => (k === "llms_txt" ? "llms.txt" : k === "agents_md" ? "AGENTS.md" : k === "skill" ? "Skill" : k);

/**
 * A site's name for a sentence: its host as written, without a leading "www."
 * ("docs.stripe.com", "backblaze.com"). Never guessed from the host's labels, so it is
 * right for any site.
 */
export function siteName(host: string): string {
  return host.replace(/^www\./, "");
}

/** The review card's title: what the site made for the user's agent, by kind. */
export function reviewTitle(kind: string, host: string): string {
  const who = siteName(host);
  if (kind === "agents_md") return `${who} wrote a guide for your agent`;
  if (kind === "llms_txt") return `${who} listed its docs for your agent`;
  if (kind === "skill") return `${who} made a skill for your agent`;
  return `${who} has a file for your agent`;
}

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

const SVG_NS = "http://www.w3.org/2000/svg";
type Shape = [tag: string, attrs: Record<string, string>];

/** A decorative line icon (24-unit box, currentColor stroke), hidden from assistive tech. */
function icon(doc: Document, size: number, shapes: Shape[], attrs: Record<string, string> = {}): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const base: Record<string, string> = { width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", ...attrs };
  for (const [k, v] of Object.entries(base)) svg.setAttribute(k, v);
  for (const [tag, a] of shapes) {
    const s = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) s.setAttribute(k, v);
    svg.append(s);
  }
  return svg;
}

const ICONS = {
  /** The mark: assets/mark.svg's ring and dot at the header's weight; the dot takes the accent. */
  mark: [["circle", { cx: "12", cy: "12", r: "9" }], ["circle", { class: "mark-dot", cx: "15", cy: "9", r: "2.6", stroke: "none" }]],
  page: [["circle", { cx: "12", cy: "12", r: "8" }], ["circle", { class: "mark-dot", cx: "14.5", cy: "9.5", r: "2", stroke: "none" }]],
  sites: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" }]],
  activity: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
  settings: [["path", { d: "M4 7h10M18 7h2M4 17h4M12 17h8" }], ["circle", { cx: "16", cy: "7", r: "2" }], ["circle", { cx: "10", cy: "17", r: "2" }]],
  pause: [["path", { d: "M9 6v12M15 6v12" }]],
  play: [["path", { d: "M8 5.5v13l10.5-6.5z" }]],
  open: [["path", { d: "M7 17L17 7M9 7h8v8" }]],
  collapse: [["path", { d: "M6 15l6-6 6 6" }]],
  next: [["path", { d: "M9 6l6 6-6 6" }]],
  file: [["path", { d: "M6 3h9l4 4v14H6z" }], ["path", { d: "M14 3v5h5" }]],
  github: [["path", { d: "M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" }]],
} satisfies Record<string, Shape[]>;

/** A site's tile: the host's first letter (drawn by CSS from `data-letter`, so it adds no text), neutral color, never a remote favicon. */
const siteTile = (doc: Document, host: string): HTMLElement => el(doc, "span", { class: "tile", "aria-hidden": "true", "data-letter": (host.replace(/^www\./, "")[0] ?? "?").toUpperCase() });

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

function button(doc: Document, key: string, label: Child, onClick: () => void, attrs: Attrs = {}, ...more: Child[]): HTMLButtonElement {
  register("click", key, onClick);
  return el(doc, "button", { type: "button", "data-key": key, "data-action": key, ...attrs }, label, ...more) as HTMLButtonElement;
}

/** A labelled switch (a checkbox with role=switch); `note` is its description. */
function toggle(doc: Document, key: string, label: Child, checked: boolean, enabled: boolean, onChange: (v: boolean) => void, note?: string, labelClass = "switch-label"): HTMLElement {
  // `click` fires after the box has flipped (pointer, Space, or its label), so `checked` is the new value.
  register("click", key, (t) => onChange((t as HTMLInputElement).checked));
  const noteId = note ? `${key}-note` : undefined;
  const input = el(doc, "input", { type: "checkbox", role: "switch", class: "switch", "data-key": key, "data-action": key, id: key, disabled: !enabled, checked, "aria-describedby": noteId }) as HTMLInputElement;
  return el(doc, "div", { class: "switch-row" }, el(doc, "div", { class: "switch-line" }, el(doc, "label", { for: key, class: labelClass }, label), input), note ? el(doc, "p", { class: "note", id: noteId, text: note }) : null);
}

// ---------- Page ----------

function resultsBlock(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement {
  const m = v.model;
  const d = m.resultsDisplay;
  const ready = d.kind === "ready";
  const heading = el(doc, "h2", { id: "results-heading", class: ready ? "results-heading" : "results-heading quiet", "data-key": "results-heading", "aria-live": "polite" }, displayHeading(d), ready ? el(doc, "span", { class: "accent-dot", text: "." }) : null);
  const box = el(doc, "section", { class: "results", "aria-labelledby": "results-heading" }, heading, el(doc, "p", { id: "results-explanation", class: `state state-${d.kind}`, text: displayExplanation(d) }));
  if (d.kind === "ready") {
    const list = el(doc, "ul", { class: "links", "aria-describedby": "results-explanation" });
    for (const item of d.items.slice(0, 3)) {
      const rec = m.linkRecord(item.candidateId);
      const pending = rec?.state === "pending";
      const card = button(
        doc,
        `open-${item.candidateId}`,
        el(doc, "span", { class: "link-text" }, el(doc, "span", { class: "link-title", text: item.title }), el(doc, "span", { class: "reason", text: pending ? "Opening…" : item.reason })),
        () => on.open(item.candidateId),
        { class: "link-card", "aria-label": `Open ${item.title} on ${item.hostname}`, disabled: pending || !m.running },
        icon(doc, 18, ICONS.open, { class: "link-arrow" }),
      );
      const failed = rec?.state === "failed" && rec.code ? el(doc, "p", { class: "error" }, `Couldn't open it: ${ACK_CODE_TEXT[rec.code]}. `, button(doc, `dismiss-${rec.id}`, "Dismiss", () => on.dismiss(rec.id), { class: "text-button" })) : null;
      list.append(el(doc, "li", {}, card, failed));
    }
    box.append(list);
  }
  for (const r of m.resultsModel.linkRefusals) {
    box.append(el(doc, "p", { class: "error" }, `A link was not opened: ${linkRefusalText(r.refusal)}. `, button(doc, `dismiss-${r.commandId}`, "Dismiss", () => on.dismiss(r.commandId), { class: "text-button" })));
  }
  return box;
}

/** The review card for the shown file (QuietReview): what it is, its streamed text, the consent line, Not now / Approve. */
function reviewCard(doc: Document, v: ViewState, on: PanelHandlers, key: PreviewKey, host: string, offers: CapabilityOffer[]): HTMLElement {
  const m = v.model;
  const a = m.preview(key);
  const offer = m.capabilities.offer(key);
  const entry = m.capabilities.libraryEntry(key.resourceId);
  const desc = a?.descriptor;
  const kind = desc?.kind ?? offer?.kind ?? entry?.kind ?? "";
  const source = desc?.sourceUrl ?? offer?.sourceUrl ?? entry?.sourceUrl ?? "";
  const total = a?.totalBytes ?? offer?.byteLength ?? null;
  const skill = desc?.skill ?? offer?.skill;
  const blocker = m.approveBlocker(key);
  const phaseText =
    a === undefined ? "Not loaded." : a.phase === "complete" ? "Complete and verified." : a.phase === "failed" && a.failure ? `Couldn't load it: ${failureText(a.failure)}.` : `Loading… ${a.bytes.length}${total !== null ? ` of ${total}` : ""} bytes`;
  const k = keyOf(key);
  const name = skill ? `${kindText(kind)} “${skill.name}”` : kindText(kind);
  const meta = [name, total === null ? null : bytesText(total), `${hostOf(source) ?? host}${pathOf(source)}`].filter((x) => x !== null).join(" · ");
  const index = offers.findIndex((o) => sameKey(o, key));
  const nextOffer = index >= 0 && offers.length > 1 ? offers[(index + 1) % offers.length]! : null;
  return el(
    doc,
    "section",
    { class: "review-card", id: "preview-pane", "aria-labelledby": "review-title" },
    el(
      doc,
      "div",
      { class: "review-head" },
      el(doc, "span", { class: "file-tile", "aria-hidden": "true" }, icon(doc, 16, ICONS.file, { "stroke-width": "2" })),
      el(doc, "div", { class: "review-heading" }, el(doc, "h2", { id: "review-title", text: reviewTitle(kind, host) }), el(doc, "p", { class: "meta", text: meta })),
      button(doc, "preview-close", icon(doc, 16, ICONS.collapse), () => on.closePreview(), { class: "icon-button", "aria-label": "Collapse", "aria-expanded": "true", "aria-controls": "preview-pane" }),
    ),
    el(doc, "pre", { class: "preview-text", tabindex: "0", "data-key": `preview-text-${k}`, "aria-label": "File text", text: a?.text ?? "" }),
    el(doc, "p", { class: a?.phase === "failed" ? "phase error" : "phase", text: phaseText }),
    el(doc, "p", { id: "approve-note", class: "note", text: blocker ?? "Approving lets your agent read this version." }),
    el(
      doc,
      "div",
      { class: "review-actions" },
      m.canDecline(key) ? button(doc, `decline-${k}`, "Not now", () => on.decline(key), { class: "secondary" }) : null,
      a?.phase === "failed" ? button(doc, `reload-${k}`, "Load again", () => on.restartPreview(key), { class: "secondary" }) : null,
      button(doc, `approve-${k}`, "Approve", () => on.approve(key), { class: "primary", disabled: blocker !== null, "aria-describedby": "approve-note" }),
    ),
    nextOffer
      ? el(
          doc,
          "div",
          { class: "review-foot" },
          el(doc, "span", { class: "note", text: `${index + 1} of ${offers.length}` }),
          button(doc, "review-next", "Next", () => on.showPreview({ resourceId: nextOffer.resourceId, version: nextOffer.version }), { class: "text-button", "aria-label": `Next file, ${index + 2 > offers.length ? 1 : index + 2} of ${offers.length}` }, icon(doc, 14, ICONS.next)),
        )
      : null,
  );
}

/** What this site has approved for the user's agent: one line each, with Revoke (or Preview to approve again). */
function approvedLines(doc: Document, v: ViewState, on: PanelHandlers, library: LibraryEntry[], offers: CapabilityOffer[]): HTMLElement | null {
  const m = v.model;
  const shown = library.filter((e) => e.state !== "no_default" || !offers.some((o) => o.resourceId === e.resourceId));
  if (shown.length === 0) return null;
  const list = el(doc, "ul", { class: "approved", "aria-label": "Approved for your agent" });
  for (const e of shown) {
    const stateText = e.state === "approved" ? "Approved" : e.state === "blocked" ? "Revoked" : "Not approved";
    const newest = e.versions[0];
    const reapprove = e.state !== "approved" && newest ? { resourceId: e.resourceId, version: newest.hash } : null;
    list.append(
      el(
        doc,
        "li",
        {},
        `${stateText}: ${kindText(e.kind)}`,
        m.canRevoke(e.resourceId) ? el(doc, "span", { class: "sep", "aria-hidden": "true", text: " · " }) : null,
        m.canRevoke(e.resourceId) ? button(doc, `revoke-${e.resourceId}`, "Revoke", () => on.revoke(e.resourceId), { class: "text-button", "aria-label": `Revoke ${kindText(e.kind)}` }) : null,
        reapprove ? el(doc, "span", { class: "sep", "aria-hidden": "true", text: " · " }) : null,
        reapprove ? button(doc, `library-preview-${keyOf(reapprove)}`, "Preview", () => on.showPreview(reapprove), { class: "text-button", "aria-label": `Preview ${kindText(e.kind)}` }) : null,
      ),
    );
  }
  return list;
}

/** The site's files for the user's agent: the pill, or the review card it expands into, then what is approved. */
function filesBlock(doc: Document, v: ViewState, on: PanelHandlers, host: string): HTMLElement[] {
  const m = v.model;
  if (!m.running || m.missingCapabilities) return [];
  const offers = m.capabilities.offersForHost(host);
  const library = m.capabilities.libraryForHost(host);
  const shown = m.shownPreview;
  const shownHere = shown !== null && (offers.some((o) => sameKey(o, shown)) || library.some((e) => e.resourceId === shown.resourceId));
  const out: HTMLElement[] = [];
  if (shown !== null && shownHere) out.push(reviewCard(doc, v, on, shown, host, offers));
  else if (offers.length > 0) {
    const first = offers[0]!;
    const n = offers.length;
    out.push(
      button(
        doc,
        "review-open",
        el(doc, "span", { class: "attention-dot", "aria-hidden": "true" }),
        () => on.showPreview({ resourceId: first.resourceId, version: first.version }),
        { class: "review-pill", "aria-expanded": "false" },
        `${siteName(host)} has ${n === 1 ? "1 file" : `${n} files`} for your agent · Review`,
      ),
    );
  }
  const approved = approvedLines(doc, v, on, library, offers);
  if (approved) out.push(approved);
  return out;
}

/**
 * "Suggest on <host>": background recommendations for an https site. Off until the user turns it
 * on; Chrome must allow the site to turn it on (turning it off never needs that). Its `data-key`
 * carries the full origin.
 */
function destinationSwitch(doc: Document, v: ViewState, on: PanelHandlers, origin: string, host: string, granted: boolean): HTMLElement {
  const m = v.model;
  const enabled = m.isDestination(origin);
  const rec = m.destinationRecord(origin);
  const note =
    rec?.state === "pending"
      ? "Waiting for Scout…"
      : !granted && !enabled
        ? "Allow this site first."
        : m.capabilities.agentBrowserContext === null
          ? "Waiting for Scout…"
          : "When you stay on a page here, Scout asks your agent for links.";
  const label = el(doc, "span", { class: "site-label" }, siteTile(doc, host), el(doc, "span", { text: `Suggest on ${host}` }));
  return toggle(doc, `destination-${origin}`, label, enabled, m.canToggleDestination(origin) && (granted || enabled), (x) => on.destination(origin, x), note, "switch-label site-switch");
}

/** The agent-context chip: only while the agent may read browser context and GitHub issue text has reached Scout. */
function contextChip(doc: Document, v: ViewState): HTMLElement | null {
  const s = v.status;
  if (v.model.capabilities.agentBrowserContext !== true || !s?.githubCapture || s.counters.forwarded === 0) return null;
  return el(doc, "p", { class: "chip" }, icon(doc, 14, ICONS.github), el(doc, "span", { text: "Using your recent GitHub activity" }));
}

function tray(doc: Document, v: ViewState, on: PanelHandlers, reviewing: boolean): HTMLElement {
  const s = v.site;
  const box = el(doc, "div", { class: "tray", role: "group", "aria-label": "This site" }, reviewing ? null : contextChip(doc, v));
  if (s.kind === "none") box.append(el(doc, "p", { class: "tray-row tray-text", text: "No tab is open in this window." }));
  else if (s.kind === "unknown") box.append(el(doc, "p", { class: "tray-row tray-text", id: "site-unknown", text: UNKNOWN_SITE_TEXT }));
  else if (s.kind === "refused") box.append(el(doc, "p", { class: "tray-row tray-text", text: siteRefusalText(s.reason) }));
  else {
    const granted = v.status?.granted.includes(s.pattern) === true;
    if (!granted) {
      box.append(
        el(
          doc,
          "div",
          { class: "tray-row allow-row" },
          el(doc, "span", { class: "site-label" }, siteTile(doc, s.host), el(doc, "span", { class: "site-host", text: `Allow Scout on ${s.host}` })),
          button(doc, "site-allow", "Allow", () => on.allow(s.pattern), { class: "primary small", "aria-label": `Allow Scout on ${s.host}` }),
        ),
      );
    }
    if (granted || v.model.isDestination(s.origin)) box.append(el(doc, "div", { class: "tray-row" }, destinationSwitch(doc, v, on, s.origin, s.host, granted)));
  }
  return box;
}

function pageView(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement[] {
  const s = v.site;
  const granted = s.kind === "ok" && v.status?.granted.includes(s.pattern) === true;
  const files = granted && s.kind === "ok" ? filesBlock(doc, v, on, s.host) : [];
  // With the review card open the results step back (QuietReview): a small heading, titles only.
  const reviewing = files.some((e) => e.id === "preview-pane");
  return [el(doc, "div", { class: reviewing ? "page-stack reviewing" : "page-stack" }, resultsBlock(doc, v, on), ...files)];
}

// ---------- Sites ----------

function sitesView(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement[] {
  const m = v.model;
  const granted = v.status?.granted ?? [];
  const rows = siteRows(granted, m.capabilities.origins, m.capabilities.destinations);
  const out: HTMLElement[] = [];
  if (rows.length === 0) out.push(el(doc, "p", { class: "note", text: "No sites yet. Allow a site to let Scout see it." }));
  const list = el(doc, "ul", { class: "sites" });
  for (const r of rows) {
    const state = (r.granted ? "Allowed" : "Not allowed") + (r.recommendations ? " · Suggestions on" : "");
    const action =
      r.pattern === null
        ? el(doc, "span", { class: "note", text: "Non-standard port" })
        : r.granted
          ? button(doc, `remove-${r.host}`, "Remove", () => on.remove(r.pattern!), { class: "secondary small", "aria-label": `Remove ${r.host}` })
          : button(doc, `allow-${r.host}`, "Allow", () => on.allow(r.pattern!), { class: "primary small", "aria-label": `Allow Scout on ${r.host}` });
    const li = el(doc, "li", {}, el(doc, "div", { class: "site-row" }, siteTile(doc, r.host), el(doc, "div", { class: "site-text" }, el(doc, "span", { class: "site-host", text: r.host }), el(doc, "span", { class: "site-state", text: state })), action));
    const setting = m.capabilities.originSetting(r.origin);
    if (setting) {
      const rec = m.autoAcquireRecord(r.origin);
      li.append(
        toggle(doc, `auto-acquire-${r.origin}`, "Approve new files automatically", setting.autoAcquire, m.canToggleAutoAcquire(r.origin), (x) => on.autoAcquire(r.origin, x, false), rec?.state === "pending" ? "Waiting for Scout…" : "New files and updates from this site are approved without a preview."),
      );
      if (v.ui.ackSheet === r.origin) {
        li.append(
          el(
            doc,
            "div",
            { class: "sheet", role: "dialog", "aria-modal": "false", "aria-labelledby": "sheet-title" },
            el(doc, "h3", { id: "sheet-title", text: "Approve this site's files without asking?" }),
            el(doc, "p", { text: `Scout will approve every new llms.txt, AGENTS.md, skill and update from ${r.host} for your agent without showing you a preview first. A site can change these files at any time.` }),
            el(doc, "div", { class: "row" }, button(doc, "sheet-cancel", "Cancel", () => on.cancelSheet(), { class: "secondary" }), button(doc, "sheet-confirm", "Turn on", () => on.autoAcquire(r.origin, true, true), { class: "primary" })),
          ),
        );
      }
    }
    list.append(li);
  }
  out.push(list);
  register("input", "site-input", (t) => {
    v.ui.siteInput = (t as HTMLInputElement).value;
  });
  register("submit", "site-add", (form) => on.allowTyped(form.querySelector<HTMLInputElement>("#site-input")?.value ?? ""));
  const input = el(doc, "input", { type: "text", id: "site-input", "data-key": "site-input", "data-input": "site-input", placeholder: "docs.example.com", autocomplete: "off", spellcheck: "false", "aria-describedby": "site-input-note", value: v.ui.siteInput }) as HTMLInputElement;
  out.push(
    el(doc, "form", { class: "add-site", "data-submit": "site-add" }, el(doc, "label", { for: "site-input", text: "Allow another site" }), el(doc, "div", { class: "row" }, input, el(doc, "button", { type: "submit", class: "primary small", "data-key": "site-add", text: "Allow" }))),
    el(doc, "p", { id: "site-input-note", class: v.ui.siteInputError ? "error" : "note", text: v.ui.siteInputError ?? "Chrome asks you to confirm each site." }),
  );
  if (v.status?.broadGrantIgnored) out.push(el(doc, "p", { class: "note", text: BROAD_GRANT_TEXT }));
  out.push(el(doc, "p", { class: "note", text: "Turn on suggestions for a site from the Page view while you're on it." }));
  return out;
}

// ---------- Activity ----------

const REQUEST_TEXT: Record<string, string> = {
  approve: "Approve",
  decline: "Decline",
  revoke: "Revoke",
  set_auto_acquire: "Auto-approve",
  set_agent_browser_context: "Agent access",
  set_destination: "Suggestions",
  set_agent: "Agent",
  refresh_capabilities: "Refresh files",
  open_link: "Open link",
};

function problemsGroup(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement | null {
  const m = v.model;
  const problems = m.problems;
  if (problems.length === 0) return null;
  const list = el(doc, "ul", { class: "problems" });
  problems.forEach((p: Problem, i) => {
    if (p.kind === "link") list.append(el(doc, "li", { text: p.text }));
    else if (p.kind === "conflict") list.append(el(doc, "li", { text: `Skill ${p.conflict.name} was left alone (${p.conflict.code.replace(/_/g, " ")}).` }));
    else if (p.kind === "preview") list.append(el(doc, "li", {}, `A preview failed: ${failureText(p.failure)}. `, button(doc, `problem-reload-${i}`, "Load again", () => on.restartPreview(p.key), { class: "text-button" })));
    else if (p.kind === "linkRefused") list.append(el(doc, "li", {}, `A link was not opened: ${linkRefusalText(p.refusal)}. `, button(doc, `problem-dismiss-${p.commandId}`, "Dismiss", () => on.dismiss(p.commandId), { class: "text-button" })));
    else {
      const r = p.record;
      const what = REQUEST_TEXT[r.request.type] ?? r.request.type;
      list.append(
        el(
          doc,
          "li",
          {},
          `${what} failed: ${r.code ? ACK_CODE_TEXT[r.code] : "unknown"}. `,
          m.canRetry(r.id) ? button(doc, `problem-retry-${r.id}`, "Retry", () => on.retry(r.id), { class: "text-button" }) : null,
          button(doc, `problem-dismiss-${r.id}`, "Dismiss", () => on.dismiss(r.id), { class: "text-button" }),
        ),
      );
    }
  });
  return el(doc, "section", { class: "group problems-group", "aria-labelledby": "problems-title" }, el(doc, "h2", { id: "problems-title" }, "Problems", el(doc, "span", { class: "count", text: String(problems.length) })), list);
}

function activityView(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement[] {
  const entries = [...v.model.capabilities.audit].reverse();
  const reads = el(doc, "section", { class: "group", "aria-labelledby": "reads-title" }, el(doc, "h2", { id: "reads-title", text: "Agent reads" }), el(doc, "p", { class: "note", text: "What your agent read through Scout, newest first. Never the text itself." }));
  if (entries.length === 0) reads.append(el(doc, "p", { text: "No reads yet." }));
  const list = el(doc, "ul", { class: "activity" });
  for (const e of entries) {
    const when = new Date(e.at).toLocaleTimeString();
    const who = e.role === "job" ? "Suggestion job" : "Your agent";
    list.append(el(doc, "li", { text: `${when} · ${who} · ${e.method.replace(/_/g, " ")} · ${e.outcome.replace(/_/g, " ")}${e.origin ? ` · ${hostOf(e.origin) ?? e.origin}` : ""}` }));
  }
  reads.append(list);
  return [problemsGroup(doc, v, on), reads].filter((x): x is HTMLElement => x !== null);
}

// ---------- Settings ----------

/** The agent row: one button per agent the core found, the chosen one pressed. None without options. */
function agentCard(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement | null {
  const m = v.model;
  const agents = m.capabilities.agents;
  if (!agents || agents.available.length === 0) return null;
  const selected = m.selectedAgent;
  const choices = el(doc, "span", { class: "row agent-choices", role: "group", "aria-labelledby": "agent-label" });
  for (const a of agents.available) {
    const chosen = a.id === selected;
    choices.append(button(doc, `agent-option-${a.id}`, a.label, () => on.agent(a.id), { class: chosen ? "secondary small chosen" : "secondary small", "aria-pressed": chosen ? "true" : "false", disabled: !m.canSetAgent }));
  }
  return el(doc, "div", { class: "card", "data-key": "agent-card" }, el(doc, "div", { class: "setting-line" }, el(doc, "span", { id: "agent-label", text: "Agent" }), choices));
}

function settingsView(doc: Document, v: ViewState, on: PanelHandlers): HTMLElement[] {
  const m = v.model;
  const c = m.pauseState.control;
  const gh = v.status?.granted.includes("https://github.com/*") === true;
  const grant = m.capabilities.agentBrowserContext;
  const grec = m.grantRecord;
  const out = [
    el(
      doc,
      "div",
      { class: "card" },
      toggle(doc, "github-capture", "GitHub issue text", v.status?.githubCapture === true, gh, (x) => on.githubCapture(x), gh ? "Scout reads the text of GitHub issues you open." : "Allow github.com in Sites first."),
      toggle(
        doc,
        "agent-context",
        "Let your agent read the current site and recent GitHub issues",
        grant === true,
        m.canToggleGrant,
        (x) => on.grant(x),
        grec?.state === "pending" || grant === null ? "Waiting for Scout…" : undefined,
      ),
    ),
    agentCard(doc, v, on),
    el(
      doc,
      "div",
      { class: "card" },
      el(doc, "div", { class: "setting-line" }, el(doc, "span", { text: m.pauseState.paused ? "Scout is paused" : "Pause Scout" }), button(doc, "pause", c.title, () => on.pause(), { class: "secondary small", disabled: !c.enabled, "aria-label": c.label })),
      el(doc, "div", { class: "setting-line" }, el(doc, "span", { text: "Connection" }), el(doc, "span", { class: "row" }, button(doc, "refresh", "Refresh files", () => on.refresh(), { class: "secondary small", disabled: !m.running }), button(doc, "reconnect", "Reconnect", () => on.reconnect(), { class: "secondary small" }))),
    ),
  ];
  const dl = el(doc, "dl", { class: "status" }, el(doc, "dt", { text: "Now" }), el(doc, "dd", { text: m.headerLine }));
  if (v.status) {
    for (const [k, val] of statusRows(v.status)) dl.append(el(doc, "dt", { text: k }), el(doc, "dd", { text: val }));
    dl.append(el(doc, "dt", { text: "Sent to Scout" }), el(doc, "dd", { id: "sent-line", text: sentText(v.status) }));
  }
  // A <details> keeps the user's open state across renders (patchNode leaves its `open` alone).
  out.push(el(doc, "details", { class: "diagnostics", "data-key": "diagnostics" }, el(doc, "summary", { text: "Diagnostics" }), dl));
  return out.filter((x): x is HTMLElement => x !== null);
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
  // A disclosure's open state is the user's, not the render's.
  const userOwned = c.tagName === "DETAILS" ? "open" : null;
  for (const { name } of [...c.attributes]) if (name !== userOwned && !n.hasAttribute(name)) c.removeAttribute(name);
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

function navButton(doc: Document, v: ViewState, on: PanelHandlers, id: PanelSection, title: string, problems: number): HTMLButtonElement {
  const current = v.model.section === id;
  const shapes = id === "page" ? ICONS.page : id === "sites" ? ICONS.sites : id === "activity" ? ICONS.activity : ICONS.settings;
  const label = id === "activity" && problems > 0 ? `${title}, ${problems === 1 ? "1 problem" : `${problems} problems`}` : title;
  return button(
    doc,
    `nav-${id}`,
    el(doc, "span", { class: "nav-icon" }, icon(doc, current ? 16 : 18, shapes), id === "activity" && problems > 0 ? el(doc, "span", { class: "nav-dot", "aria-hidden": "true" }) : null),
    () => on.select(id),
    { class: current ? "nav-item current" : "nav-item", "aria-label": label, "aria-current": current ? "page" : undefined, "aria-controls": "section" },
    current ? el(doc, "span", { class: "nav-label", text: title }) : null,
  );
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
  const c = m.pauseState.control;
  const working = m.resultsDisplay.kind === "working";
  const header = el(
    doc,
    "header",
    { class: "top" },
    icon(doc, 24, ICONS.mark, { class: working ? "mark working" : "mark", role: "img", "aria-label": "Scout", "aria-hidden": "false" }),
    button(doc, "header-pause", icon(doc, 18, c.pause ? ICONS.pause : ICONS.play), () => on.pause(), { class: "icon-button", "aria-label": c.label, disabled: !c.enabled }),
  );
  const title = SECTIONS.find((s) => s.id === m.section)!.title;
  const body = m.section === "page" ? pageView(doc, v, on) : m.section === "sites" ? sitesView(doc, v, on) : m.section === "activity" ? activityView(doc, v, on) : settingsView(doc, v, on);
  const main = el(doc, "main", { id: "section", class: `view view-${m.section}`, "aria-labelledby": "section-title", "data-key": `view-${m.section}` }, el(doc, "h1", { id: "section-title", class: m.section === "page" ? "sr-only" : "view-title", text: title }), ...body);
  const problems = m.problems.length;
  const nav = el(doc, "nav", { class: "nav", "aria-label": "Scout sections" });
  for (const s of SECTIONS) nav.append(navButton(doc, v, on, s.id, s.title, problems));
  const reviewing = main.querySelector("#preview-pane") !== null;
  const next = el(doc, "div", {}, header, main, m.section === "page" ? tray(doc, v, on, reviewing) : null, nav);
  const hadCard = root.querySelector("#preview-pane") !== null;
  patchChildren(root, next);
  // A review card that just opened is brought into view (the Page view is bottom-aligned and scrolls).
  const card = root.querySelector<HTMLElement>("#preview-pane");
  if (card && !hadCard && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });

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
