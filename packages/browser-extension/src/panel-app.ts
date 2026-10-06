// The side panel page's adapter (`chrome` and the document injected): the port to the worker,
// the heartbeat, the window's active tab, and the few Chrome calls the panel makes itself
// (permissions.request/remove on a click, tabs.create for an authorized link). Every decision
// is in panel/*.ts; this file only moves events in and commands out.
//
// - One window-wide panel: it follows the active tab of its own window (tabs.onActivated,
//   tabs.onUpdated, windows.onFocusChanged, filtered by its windowId) and asks the worker what
//   that tab's site is. Without a grant or the toolbar click's activeTab grant the URL is not
//   visible, and the panel says so ("Click the Scout icon to check this site").
// - Commands go to the worker one at a time per ID; a command the worker could not hand to a
//   ready port stays unsent and goes again under the same ID once a second (open_link fails
//   instead, model rule). A line of COMMAND_MAX_BYTES or more is never sent. A written command
//   with no answer in 10 s expires (commands.ts PENDING_TIMEOUT_MS).
// - Frames are taken as they come: the core may drop non-ack frames under backpressure and
//   repaint later, and every `capabilities`/`state` frame replaces what the panel showed.
// - A link opens only from an ok `open_link` ack that passed links.ts, in a new tab next to the
//   current one (never in the current tab). That new tab is a new visit, so the results clear.
// - Allow/Remove call permissions.request/remove as the click handler's first statement (a user
//   gesture), with the exact match pattern `https://<host>/*`.

import { COMMAND_MAX_BYTES, commandLineBytes, type PanelCommand } from "./panel/commands.js";
import { PanelModel } from "./panel/model.js";
import { sha256Hex } from "./panel/preview.js";
import { type CurrentSite, parseSiteInput } from "./panel/sites.js";
import { type PanelHandlers, type PanelUi, renderPanel } from "./panel/view.js";
import {
  type CommandReply,
  PANEL_HEARTBEAT_MS,
  PANEL_PORT_NAME,
  type PanelPortRequest,
  type PauseReply,
  type StatusSnapshot,
  type WorkerToPanel,
} from "./messages.js";

export const RESEND_MS = 1000;
export const RECONNECT_MS = 500;

export interface PanelAppDeps {
  ch: typeof chrome;
  doc: Document;
  root: HTMLElement;
  model?: PanelModel;
  setInterval?: (fn: () => void, ms: number) => unknown;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
}

export interface PanelApp {
  start(): Promise<void>;
  readonly model: PanelModel;
  readonly site: CurrentSite;
  readonly status: StatusSnapshot | null;
  /** Renders now (tests; the app renders after every event on its own). */
  render(): void;
  /** Resolves when every queued effect (requests, hashing, tab creation) has settled (tests). */
  idle(): Promise<void>;
}

export function createPanelApp(deps: PanelAppDeps): PanelApp {
  const { ch, doc, root } = deps;
  const every = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const later = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const now = deps.now ?? (() => Date.now());
  const model = deps.model ?? new PanelModel();
  const ui: PanelUi = { ackSheet: null, siteInput: "", siteInputError: null };
  let status: StatusSnapshot | null = null;
  let site: CurrentSite = { kind: "none" };
  let windowId: number | null = null;
  let port: chrome.runtime.Port | null = null;
  let nextId = 1;
  const replies = new Map<number, (r: unknown) => void>();
  const inFlight = new Set<string>();
  const verifying = new Set<string>();
  const effects = new Set<Promise<unknown>>();
  let renderQueued = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    effects.add(p);
    void p.finally(() => effects.delete(p)).catch(() => {});
    return p;
  };

  function render(): void {
    renderQueued = false;
    renderPanel(doc, root, { model, status, site, ui }, handlers);
  }
  function renderSoon(): void {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(render);
  }

  // ---------- the worker ----------

  function request<T>(req: PanelPortRequest): Promise<T | null> {
    const p = port;
    if (!p) return Promise.resolve(null);
    const id = nextId++;
    return track(
      new Promise<T | null>((resolve) => {
        replies.set(id, resolve as (r: unknown) => void);
        try {
          p.postMessage({ type: "request", id, request: req });
        } catch {
          replies.delete(id);
          resolve(null);
        }
      }),
    );
  }

  function send(commands: PanelCommand[]): void {
    for (const c of commands) {
      if (inFlight.has(c.commandId)) continue;
      if (commandLineBytes(c) >= COMMAND_MAX_BYTES) {
        model.markSent(c, "oversize");
        continue;
      }
      inFlight.add(c.commandId);
      void request<CommandReply>({ type: "command", command: c }).then((r) => {
        inFlight.delete(c.commandId);
        const written = r?.written === true;
        // Invalid (not a relay command): failed for good, never resent.
        const invalid = !written && r?.invalid === true;
        model.markSent(c, written ? "written" : invalid ? "invalid" : "retryLater", now());
        // Not sent (no ready port, or the host reports the core unavailable): nothing is queued
        // in the worker; learn the link state so the panel says why and stops resending.
        if (!written && !invalid) void refreshStatus();
        renderSoon();
      });
    }
    renderSoon();
  }

  function onStatus(s: StatusSnapshot): void {
    status = s;
    send(model.applyLink(s.link));
  }

  function onWorker(m: WorkerToPanel): void {
    if (m.type === "status") {
      const grantsChanged = status?.granted.join() !== m.status.granted.join();
      onStatus(m.status);
      if (grantsChanged) void refreshSite();
    } else if (m.type === "frame") {
      send(model.apply(m.state));
      verifyPreviews();
      openLinks();
    } else if (m.type === "site-check") {
      void refreshSite();
    } else if (m.type === "reply") {
      const r = replies.get(m.id);
      replies.delete(m.id);
      r?.(m.result);
    }
    renderSoon();
  }

  function connect(): void {
    let p: chrome.runtime.Port;
    try {
      p = ch.runtime.connect({ name: PANEL_PORT_NAME });
    } catch {
      later(connect, RECONNECT_MS);
      return;
    }
    port = p;
    p.onMessage.addListener((m: unknown) => onWorker(m as WorkerToPanel));
    reportWindow();
    p.onDisconnect.addListener(() => {
      void ch.runtime.lastError;
      if (port !== p) return;
      port = null;
      for (const r of replies.values()) r(null);
      replies.clear();
      // The worker restarted: its native port went with it, and the core repaints the new one.
      send(model.applyLink("connecting"));
      renderSoon();
      later(connect, RECONNECT_MS);
    });
  }

  /** Tells the worker this panel's window, so a toolbar click there closes the panel. */
  function reportWindow(): void {
    if (windowId === null) return;
    try {
      port?.postMessage({ type: "window", windowId });
    } catch {
      // the disconnect handler reconnects, and reports again
    }
  }

  // ---------- effects of frames ----------

  function verifyPreviews(): void {
    for (const a of model.previewsToVerify()) {
      const id = `${a.key.resourceId}/${a.key.version}`;
      if (verifying.has(id)) continue;
      verifying.add(id);
      const bytes = a.bytes;
      void track(
        sha256Hex(bytes).then(
          (digest) => {
            verifying.delete(id);
            if (model.preview(a.key) === a) model.previewVerified(a.key, digest);
            renderSoon();
          },
          () => {
            verifying.delete(id);
            if (model.preview(a.key) === a) model.previewVerified(a.key, "");
            renderSoon();
          },
        ),
      );
    }
  }

  function openLinks(): void {
    for (const link of model.takeLinksToOpen()) {
      const plain: chrome.tabs.CreateProperties = { url: link.href, active: true };
      if (windowId !== null) plain.windowId = windowId;
      const props: chrome.tabs.CreateProperties = { ...plain };
      if (site.kind !== "none" && site.tabId !== null) props.openerTabId = site.tabId;
      if (site.kind !== "none" && site.index !== null) props.index = site.index + 1;
      const placed = props.openerTabId !== undefined || props.index !== undefined;
      void track(
        Promise.resolve()
          .then(() => ch.tabs.create(props))
          // The site's tab can close or move between the frame and the click: open it plainly once.
          .catch((e: unknown) => {
            if (!placed) throw e;
            return ch.tabs.create(plain);
          })
          .then(
            (tab) => {
              if (!tab) model.linkRefused(link.commandId, "open_failed");
            },
            () => model.linkRefused(link.commandId, "open_failed"),
          )
          .then(renderSoon),
      );
    }
  }

  // ---------- the current site ----------

  async function refreshSite(): Promise<void> {
    if (windowId === null) return;
    const r = await request<CurrentSite>({ type: "site", windowId });
    site = r ?? { kind: "none" };
    renderSoon();
  }

  async function refreshStatus(): Promise<void> {
    const s = await request<StatusSnapshot>({ type: "status" });
    if (s) onStatus(s);
    renderSoon();
  }

  // ---------- user actions ----------

  const handlers: PanelHandlers = {
    select(section) {
      if (section !== "sites") ui.ackSheet = null; // the auto-approve sheet belongs to its Sites row
      model.select(section);
      render();
    },
    open(candidateId) {
      const c = model.openResult(candidateId);
      if (c) send([c]);
    },
    allow(pattern) {
      // First statement: Chrome accepts the request only within the click's user gesture.
      void track(Promise.resolve(ch.permissions.request({ origins: [pattern] })).catch(() => false).then(() => Promise.all([refreshStatus(), refreshSite()])));
    },
    remove(pattern) {
      void track(Promise.resolve(ch.permissions.remove({ origins: [pattern] })).catch(() => false).then(() => Promise.all([refreshStatus(), refreshSite()])));
    },
    allowTyped(text) {
      const v = parseSiteInput(text);
      if (!v.ok) {
        ui.siteInputError = v.reason;
        render();
        return;
      }
      ui.siteInputError = null;
      void track(
        Promise.resolve(ch.permissions.request({ origins: [v.pattern] }))
          .catch(() => false)
          .then((granted) => {
            if (granted) ui.siteInput = "";
            return Promise.all([refreshStatus(), refreshSite()]);
          }),
      );
    },
    showPreview(key) {
      const c = model.showPreview(key);
      if (c) send([c]);
      render();
    },
    restartPreview(key) {
      const c = model.restartPreview(key);
      if (c) send([c]);
      render();
    },
    closePreview() {
      model.closePreview();
      render();
    },
    approve(key) {
      const c = model.approve(key);
      if (c) send([c]);
    },
    decline(key) {
      const c = model.decline(key);
      if (c) send([c]);
    },
    revoke(resourceId) {
      const c = model.revoke(resourceId);
      if (c) send([c]);
    },
    autoAcquire(origin, enabled, acknowledged) {
      if (enabled && !acknowledged) {
        ui.ackSheet = origin; // the acknowledgement sheet; the checkbox stays as the core reports it
        render();
        return;
      }
      ui.ackSheet = null;
      const c = model.setAutoAcquire(origin, enabled, acknowledged);
      if (c) send([c]);
      render();
    },
    cancelSheet() {
      ui.ackSheet = null;
      render();
    },
    grant(enabled) {
      const c = model.setAgentBrowserContext(enabled);
      if (c) send([c]);
      render();
    },
    destination(origin, enabled) {
      const c = model.setDestination(origin, enabled);
      if (c) send([c]);
      render();
    },
    agent(id) {
      const c = model.setAgent(id);
      if (c) send([c]);
      render();
    },
    pause() {
      const pause = model.pauseState.request();
      if (pause === null) return;
      void request<PauseReply>({ type: "pause", paused: pause }).then((r) => {
        if (r) {
          onStatus(r.status);
          model.pauseState.sent(pause, r.written, now());
        }
        renderSoon();
      });
    },
    githubCapture(enabled) {
      void request<StatusSnapshot>({ type: "github-capture", enabled }).then((s) => {
        if (s) onStatus(s);
        renderSoon();
      });
    },
    reconnect() {
      void request<StatusSnapshot>({ type: "reconnect" }).then((s) => {
        if (s) onStatus(s);
        renderSoon();
      });
    },
    refresh() {
      const c = model.refreshCapabilities();
      if (c) send([c]);
    },
    retry(commandId) {
      const c = model.retry(commandId);
      if (c) send([c]);
    },
    dismiss(commandId) {
      model.dismiss(commandId);
      render();
    },
  };

  async function start(): Promise<void> {
    connect();
    const win = await ch.windows.getCurrent().catch(() => null);
    windowId = typeof win?.id === "number" ? win.id : null;
    reportWindow();
    ch.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) void refreshSite();
    });
    ch.tabs.onUpdated.addListener((_id, info, tab) => {
      if (tab?.windowId === windowId && tab.active && (info.url !== undefined || info.status === "complete")) void refreshSite();
    });
    ch.windows.onFocusChanged.addListener((id) => {
      if (id === windowId) void refreshSite();
    });
    ch.permissions.onAdded.addListener(() => void refreshSite());
    ch.permissions.onRemoved.addListener(() => void refreshSite());
    doc.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // The innermost thing first: the sheet, then the review card, then back to Page.
      if (ui.ackSheet !== null) ui.ackSheet = null;
      else if (model.section === "page" && model.shownPreview !== null) model.closePreview();
      else model.select("page"); // a review card stays open on Page
      render();
    });
    every(() => {
      try {
        port?.postMessage({ type: "hb" });
      } catch {
        // the disconnect handler reconnects
      }
    }, PANEL_HEARTBEAT_MS);
    every(() => {
      model.expirePending(now());
      if (model.running) send(model.commands.unsent);
      else renderSoon();
    }, RESEND_MS);
    render();
    await refreshSite();
  }

  return {
    start,
    model,
    get site() {
      return site;
    },
    get status() {
      return status;
    },
    render,
    async idle() {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 0));
        if (effects.size === 0 && !renderQueued) {
          await new Promise((r) => setTimeout(r, 0));
          if (effects.size === 0) return;
        }
        await Promise.allSettled([...effects]);
      }
    },
  };
}
