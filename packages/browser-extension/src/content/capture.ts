// The SPA-aware capture controller (pure; window, document, navigation and
// clock injected). Ported from the Phase 0 spike.
//
// On every page it only watches the URL (Navigation API `currententrychange`
// plus a 1 s URL check). Every URL change bumps `navCounter` and cancels
// in-flight work. Only on an issue path, and only while the document is
// visible, does it ask the background for approval (active tab of the focused
// window, permission granted, not paused, bridge up). After approval it waits
// until the title and body exist and are unchanged for 500 ms (capped at 5 s).
// The result is sent only if `location.href` and `navCounter` still match the
// values captured when the extraction started. On any other path it reads
// nothing and sends nothing.

import type { ApproveResponse, PageTextMessage } from "../messages.js";
import { parseIssueRoute } from "../route.js";
import { LIMITS, type Limits } from "../selectors.js";
import { type ExtractResult, extractIssue } from "./extract.js";

export interface ContentClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The Navigation API surface this controller uses (absent in jsdom and older browsers). */
export type NavigationLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

type MutationObserverCtor = new (cb: MutationCallback) => Pick<MutationObserver, "observe" | "disconnect">;

export interface CaptureEnv {
  win: Pick<Window, "location" | "addEventListener" | "removeEventListener">;
  doc: Document;
  navigation?: NavigationLike | null;
  requestApproval(m: { navCounter: number; url: string }): Promise<ApproveResponse>;
  sendPageText(m: PageTextMessage): Promise<unknown>;
  clock?: ContentClock;
  MutationObserver?: MutationObserverCtor | null;
  limits?: Partial<Limits>;
  /** Checked on every poll tick; false (e.g. the extension was reloaded) stops the controller. */
  alive?: () => boolean;
}

export type CapturePhase = "idle" | "waiting-visible" | "approving" | "denied" | "settling" | "failed" | "sent" | "cancelled";

export interface CaptureController {
  readonly state: { phase: CapturePhase; lastReason: string | null; extractions: number; sent: number };
  readonly navCounter: number;
  readonly stopped: boolean;
  start(): void;
  /** Background asked for a fresh capture of the current page. */
  refresh(): void;
  /** URL check (also run every pollMs). */
  checkUrl(): void;
  /** Stop any in-flight read now (pause, revoke, tab change). */
  cancel(): void;
  stop(): void;
}

const defaultClock = (): ContentClock => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
});

export function createCaptureController(env: CaptureEnv): CaptureController {
  const { win, doc } = env;
  const limits: Limits = { ...LIMITS, ...(env.limits ?? {}) };
  const clock = env.clock ?? defaultClock();
  const MO = env.MutationObserver === undefined ? (globalThis.MutationObserver ?? null) : env.MutationObserver;

  let navCounter = 0;
  /** Bumped by every navigation, cancel, hide and stop; a running job gives up when it moves. */
  let job = 0;
  let href: string | null = null;
  let stopped = false;
  let capturedNav = -1;
  let pollTimer: unknown = null;
  const state: CaptureController["state"] = { phase: "idle", lastReason: null, extractions: 0, sent: 0 };
  const listeners: Array<() => void> = [];

  const on = (target: NavigationLike | null | undefined, type: string, fn: () => void) => {
    if (!target) return;
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const sleep = (ms: number) => new Promise<void>((r) => void clock.setTimeout(r, ms));

  async function runJob(): Promise<void> {
    const myNav = navCounter;
    const myJob = ++job;
    const myHref = win.location.href;
    const route = parseIssueRoute(myHref);
    if (!route || stopped) return;
    if (doc.visibilityState !== "visible") {
      state.phase = "waiting-visible";
      return;
    }
    const alive = () => !stopped && myJob === job && myNav === navCounter && win.location.href === myHref && doc.visibilityState === "visible";

    state.phase = "approving";
    let appr: ApproveResponse | null;
    try {
      appr = await env.requestApproval({ navCounter: myNav, url: myHref });
    } catch {
      appr = null;
    }
    if (!alive()) return;
    if (!appr || appr.approved !== true) {
      state.phase = "denied";
      state.lastReason = appr?.reason ?? "no-approval";
      return;
    }

    state.phase = "settling";
    state.extractions++;
    const t0 = clock.now();
    let dirty = true;
    const mo = MO ? new MO(() => (dirty = true)) : null;
    mo?.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    let lastSig: string | null = null;
    let stableSince = 0;
    let result: Extract<ExtractResult, { ok: true }> | null = null;
    let lastReason = "unsettled";
    try {
      for (;;) {
        if (!alive()) return;
        const t = clock.now();
        if (dirty || lastSig === null || !mo) {
          dirty = false;
          const r = extractIssue(doc, route, limits);
          if (r.ok) {
            const sig = `${r.title}\u0000${r.body}\u0000${r.bodyTruncated}`;
            if (sig !== lastSig) {
              lastSig = sig;
              stableSince = t;
            }
            result = r;
          } else {
            lastSig = null;
            result = null;
            lastReason = r.reason;
          }
        }
        if (result && t - stableSince >= limits.settleMs) break;
        if (t - t0 >= limits.maxWaitMs) {
          result = null;
          break;
        }
        await sleep(limits.tickMs);
      }
    } finally {
      mo?.disconnect();
    }
    // The navCounter/href gate: a settle that finishes after navigation is dropped.
    if (!alive()) return;
    if (!result) {
      state.phase = "failed";
      state.lastReason = lastReason;
      return;
    }
    capturedNav = myNav;
    state.phase = "sent";
    state.sent++;
    const msg: PageTextMessage = {
      type: "page_text",
      navCounter: myNav,
      url: myHref,
      title: result.title,
      text: result.body,
      truncated: result.bodyTruncated,
    };
    result = null;
    await env.sendPageText(msg).catch(() => {});
  }

  function onNavigate(): void {
    navCounter++;
    job++; // cancel in-flight work for the previous URL
    href = win.location.href;
    if (parseIssueRoute(href)) void runJob();
    else state.phase = "idle";
  }

  function checkUrl(): void {
    if (stopped) return;
    if (win.location.href !== href) onNavigate();
  }

  function cancel(): void {
    job++;
    if (state.phase === "approving" || state.phase === "settling") state.phase = "cancelled";
  }

  function retryIfNeeded(): void {
    if (capturedNav !== navCounter && parseIssueRoute(win.location.href)) void runJob();
  }

  function onFocus(): void {
    if (stopped || doc.visibilityState !== "visible") return;
    checkUrl();
    retryIfNeeded();
  }

  function onVisibility(): void {
    if (stopped) return;
    if (doc.visibilityState !== "visible") {
      job++; // never keep reading a hidden page
      if (state.phase === "approving" || state.phase === "settling") state.phase = "waiting-visible";
      return;
    }
    checkUrl();
    retryIfNeeded();
  }

  const ctl: CaptureController = {
    state,
    get navCounter() {
      return navCounter;
    },
    get stopped() {
      return stopped;
    },
    start() {
      href = win.location.href;
      on(env.navigation, "currententrychange", checkUrl);
      on(win, "popstate", checkUrl);
      on(doc, "visibilitychange", onVisibility);
      on(win, "blur", cancel); // window lost focus: fail closed locally too
      on(win, "focus", onFocus);
      pollTimer = clock.setInterval(() => {
        if (env.alive && !env.alive()) ctl.stop();
        else checkUrl();
      }, limits.pollMs);
      if (parseIssueRoute(href)) void runJob();
    },
    refresh() {
      if (stopped) return;
      const before = navCounter;
      checkUrl();
      if (navCounter !== before) return; // the navigation already started a job
      if (parseIssueRoute(win.location.href)) void runJob();
    },
    checkUrl,
    cancel,
    stop() {
      stopped = true;
      job++;
      if (pollTimer !== null) clock.clearInterval(pollTimer);
      pollTimer = null;
      for (const off of listeners.splice(0)) off();
    },
  };
  return ctl;
}
