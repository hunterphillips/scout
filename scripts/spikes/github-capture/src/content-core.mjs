// Scout Phase 0 GitHub capture spike: content-script logic (pure; DOM injected).
//
// Order of gates for every capture attempt, all BEFORE any page text is read:
//   1. the current href passes the issue-route gate (route.mjs);
//   2. the document is visible;
//   3. the background approves (active tab of the focused window, top frame,
//      permission granted, not paused, bridge connected);
//   4. the issue identity link in the DOM (an href attribute, not text) names
//      the same owner/repo/number as the URL, so stale SPA DOM left over from
//      the previous page is never read as the new issue.
// Only the title and the main issue body are read, through a bounded text
// walker that skips form controls, contenteditable, buttons, scripts and
// hidden subtrees. Nothing is written to the page, nothing is fetched, nothing
// is logged, nothing is stored. Each navigation bumps a generation; any job
// from an older generation, an older URL or a hidden document is dropped.

import { parseIssueRoute } from "./route.mjs";
import { LIMITS, SELECTORS } from "./selectors.mjs";

const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "FORM", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BR", "TR", "BLOCKQUOTE", "TABLE", "SECTION", "DETAILS", "SUMMARY", "HR", "DD", "DT"]);
const EDITABLE_ANCESTOR = 'form, textarea, input, select, [contenteditable]:not([contenteditable="false"])';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8Length = (s) => encoder.encode(s).length;

/** Cut to at most maxBytes of UTF-8 on a code-point boundary. */
export function truncateUtf8(text, maxBytes) {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false, bytes: bytes.length };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const cut = decoder.decode(bytes.subarray(0, end));
  return { text: cut, truncated: true, bytes: end };
}

/** Cut to at most maxChars code points. */
export function truncateChars(text, maxChars) {
  const cps = Array.from(text);
  if (cps.length <= maxChars) return { text, truncated: false, chars: cps.length };
  return { text: cps.slice(0, maxChars).join(""), truncated: true, chars: maxChars };
}

function normalize(s) {
  return s
    .replace(/[ \t\f\v\r ]+/g, " ")
    .replace(/ *\n[ \n]*/g, (m) => (m.split("\n").length > 2 ? "\n\n" : "\n"))
    .trim();
}

/**
 * Bounded text of `el`: text nodes only, skipping controls, editable and
 * hidden subtrees. Stops walking once `maxBytes` of raw text are collected.
 */
export function boundedText(el, maxBytes) {
  const doc = el.ownerDocument;
  const NF = doc.defaultView.NodeFilter;
  const pieces = [];
  let raw = 0;
  let stoppedEarly = false;
  const walker = doc.createTreeWalker(el, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const tag = n.tagName.toUpperCase();
        const ce = n.getAttribute("contenteditable");
        if (SKIP_TAGS.has(tag) || (ce !== null && ce !== "false") || n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true") {
          return NF.FILTER_REJECT;
        }
        if (BLOCK_TAGS.has(tag)) pieces.push("\n");
        return NF.FILTER_SKIP;
      }
      return NF.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue ?? "";
    pieces.push(v);
    raw += utf8Length(v);
    if (raw > maxBytes + 1024) {
      stoppedEarly = true;
      break;
    }
  }
  return { text: normalize(pieces.join("")), stoppedEarly };
}

function unique(doc, candidates) {
  for (const c of candidates) {
    const els = doc.querySelectorAll(c.css);
    if (els.length === 1) return { el: els[0], id: c.id };
    if (els.length > 1) return { ambiguous: true, id: c.id };
  }
  return null;
}

function isEditable(el) {
  return !!el.closest(EDITABLE_ANCESTOR) || el.isContentEditable === true;
}

/**
 * Extract title + main body for `route` from `doc`. Reads the identity href
 * first; reads text only if it matches the route.
 */
export function extractIssue(doc, route, limits = LIMITS) {
  const idm = unique(doc, SELECTORS.identity);
  if (!idm) return { ok: false, reason: "identity-missing" };
  if (idm.ambiguous) return { ok: false, reason: "identity-ambiguous" };
  const href = idm.el.getAttribute("href");
  let idRoute = null;
  try {
    const u = new URL(href ?? "", "https://github.com");
    u.hash = "";
    u.search = "";
    idRoute = parseIssueRoute(u.href);
  } catch {
    idRoute = null;
  }
  if (!idRoute || idRoute.key !== route.key) return { ok: false, reason: "identity-mismatch" };

  const t = unique(doc, SELECTORS.title);
  const b = unique(doc, SELECTORS.body);
  if (!t || !b) return { ok: false, reason: !t ? "title-missing" : "body-missing" };
  if (t.ambiguous || b.ambiguous) return { ok: false, reason: "ambiguous" };
  if (isEditable(t.el) || isEditable(b.el)) return { ok: false, reason: "editable" };

  const tt = boundedText(t.el, limits.titleChars * 4);
  const title = truncateChars(tt.text.replace(/\s+/g, " "), limits.titleChars);
  if (!title.text) return { ok: false, reason: "title-empty" };
  const bt = boundedText(b.el, limits.bodyBytes);
  const body = truncateUtf8(bt.text, limits.bodyBytes);
  return {
    ok: true,
    title: title.text,
    body: body.text,
    titleTruncated: title.truncated || tt.stoppedEarly,
    bodyTruncated: body.truncated || bt.stoppedEarly,
    titleChars: title.chars,
    bodyBytes: body.bytes,
    selectorIds: [idm.id, t.id, b.id],
  };
}

/**
 * The SPA-aware capture state machine.
 * env: { win, doc, requestApproval({gen, routeKey}) -> Promise<{approved, token?, reason?}>,
 *        sendCapture(payload) -> Promise, sendRoute({issue, gen}) -> void,
 *        now?, setTimeout?, clearTimeout?, setInterval?, clearInterval?, MutationObserver?, limits? }
 */
export function createCaptureController(env) {
  const { win, doc } = env;
  const limits = { ...LIMITS, ...(env.limits ?? {}) };
  const now = env.now ?? (() => Date.now());
  const setT = env.setTimeout ?? win.setTimeout.bind(win);
  const setI = env.setInterval ?? win.setInterval.bind(win);
  const clearI = env.clearInterval ?? win.clearInterval.bind(win);
  const MO = env.MutationObserver ?? win.MutationObserver;

  let gen = 0;
  let job = 0;
  let href = null;
  let stopped = false;
  let capturedGen = -1;
  let pollTimer = null;
  const state = { phase: "idle", lastReason: null, jobs: 0, sent: 0, cancels: 0 };
  const listeners = [];

  const on = (target, type, fn) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const sleep = (ms) => new Promise((r) => setT(r, ms));

  async function runJob(reason) {
    const myGen = gen;
    const myJob = ++job;
    const myHref = win.location.href;
    const route = parseIssueRoute(myHref);
    if (!route || stopped) return;
    if (doc.visibilityState !== "visible") {
      state.phase = "waiting-visible";
      return;
    }
    const alive = () => !stopped && myJob === job && myGen === gen && win.location.href === myHref && doc.visibilityState === "visible";
    state.jobs++;
    state.phase = "approving";
    let appr;
    try {
      appr = await env.requestApproval({ gen: myGen, routeKey: route.key, reason });
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
    const t0 = now();
    let dirty = true;
    const mo = MO ? new MO(() => (dirty = true)) : null;
    if (mo) mo.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    let lastSig = null;
    let stableSince = 0;
    let result = null;
    let lastReason = "unsettled";
    try {
      for (;;) {
        if (!alive()) return;
        const t = now();
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
      if (mo) mo.disconnect();
    }
    if (!alive()) return;
    const settleMs = now() - t0;
    if (!result) {
      state.phase = "failed";
      state.lastReason = lastReason;
      await env.sendCapture({ type: "capture-failed", gen: myGen, token: appr.token, routeKey: route.key, reason: lastReason, settleMs }).catch(() => {});
      return;
    }
    capturedGen = myGen;
    state.phase = "sent";
    state.sent++;
    const payload = {
      type: "capture",
      gen: myGen,
      token: appr.token,
      routeKey: route.key,
      title: result.title,
      body: result.body,
      titleTruncated: result.titleTruncated,
      bodyTruncated: result.bodyTruncated,
      selectorIds: result.selectorIds,
      settleMs,
    };
    result = null;
    await env.sendCapture(payload).catch(() => {});
  }

  function onNavigate() {
    gen++;
    job++; // cancel in-flight work for the previous URL
    href = win.location.href;
    const route = parseIssueRoute(href);
    if (route) void runJob("navigate");
    else {
      state.phase = "idle";
      env.sendRoute({ issue: false, gen });
    }
  }

  function checkUrl() {
    if (stopped) return;
    if (win.location.href !== href) onNavigate();
  }

  /** Stop any in-flight read now (pause, revoke, focus loss). Re-armed by refresh. */
  function cancel() {
    job++;
    if (state.phase === "approving" || state.phase === "settling") state.phase = "cancelled";
    state.cancels++;
  }

  function onFocus() {
    if (stopped || doc.visibilityState !== "visible") return;
    checkUrl();
    if (capturedGen !== gen && parseIssueRoute(win.location.href)) void runJob("focus");
  }

  function onVisibility() {
    if (stopped) return;
    if (doc.visibilityState !== "visible") {
      job++; // never keep reading a hidden page
      if (state.phase === "approving" || state.phase === "settling") state.phase = "waiting-visible";
      return;
    }
    checkUrl();
    if (capturedGen !== gen && parseIssueRoute(win.location.href)) void runJob("visible");
  }

  return {
    state,
    get gen() {
      return gen;
    },
    start() {
      href = win.location.href;
      on(win, "popstate", checkUrl);
      on(win, "pageshow", checkUrl);
      on(win.navigation, "navigatesuccess", checkUrl);
      on(doc, "visibilitychange", onVisibility);
      on(win, "blur", cancel); // window lost focus: fail closed locally too
      on(win, "focus", onFocus);
      pollTimer = setI(checkUrl, limits.pollMs);
      if (parseIssueRoute(href)) void runJob("load");
      else env.sendRoute({ issue: false, gen });
    },
    /** Background asked for a fresh capture of the current page. */
    refresh() {
      if (stopped) return;
      checkUrl();
      if (parseIssueRoute(win.location.href)) void runJob("refresh");
    },
    checkUrl,
    cancel,
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      job++;
      if (pollTimer !== null) clearI(pollTimer);
      for (const off of listeners.splice(0)) off();
    },
  };
}

/**
 * Content-script entry. `chrome` is the extension API object. A holder on the
 * isolated-world global keeps one live controller per page: re-injection is a
 * no-op while it runs, and starts a fresh one after a revoke stopped it.
 */
export function startContentScript(chrome, win) {
  const holder = win.__scoutGithubCaptureSpike ?? (win.__scoutGithubCaptureSpike = { ctl: null, listening: false });
  if (holder.ctl && !holder.ctl.stopped) return null;
  let ctl = null;
  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch((e) => {
      // Extension reloaded or messaging unavailable: fail closed.
      if (ctl) ctl.stop();
      throw e;
    });
  ctl = createCaptureController({
    win,
    doc: win.document,
    requestApproval: (m) => send({ type: "approve", gen: m.gen, routeKey: m.routeKey }),
    sendCapture: (p) => send(p),
    sendRoute: (p) => void send({ type: "route", issue: p.issue, gen: p.gen }).catch(() => {}),
  });
  holder.ctl = ctl;
  if (!holder.listening) {
    holder.listening = true;
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender?.id !== chrome.runtime.id || !holder.ctl) return;
      if (msg?.type === "refresh") holder.ctl.refresh();
      else if (msg?.type === "cancel") {
        holder.ctl.cancel();
        if (msg.stop === true) holder.ctl.stop();
      }
    });
  }
  ctl.start();
  return ctl;
}
