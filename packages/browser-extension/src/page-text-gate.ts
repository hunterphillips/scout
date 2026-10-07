// The approval gate for GitHub issue text, and the content-script messaging
// around it (refresh, cancel). Page text passes through memory once,
// straight to the native port; it is never stored or logged.
//
// Kept from the live-verified Phase 0 spike:
// - sender.url is not a route authority: Chrome appears to keep it at the
//   document's first URL across GitHub's in-page navigation. It is checked for
//   origin only. The route comes from the browser-owned tab URL: sender.tab.url
//   at request time, then a fresh active-tab query.
// - the cancel epoch (shared state), bumped by pause, revoke, tab change,
//   focus loss and port loss, that approval and forwarding snapshot on entry
//   and re-check after every await.
//
// Capture needs three things, each checked on approval and again before
// forwarding: Chrome's exact GitHub grant (from the background's reconciled
// list, never a broad all-sites grant), the user's GitHub-capture toggle, and a
// core capture_policy on this port with capture enabled and not paused. The
// policy can only take capture away; it never stands in for the other two.

import { type PageTextObservation, PageTextObservationSchema } from "@scout/contracts";
import type { ApproveRequest, ApproveResponse, BackgroundToContent, DenialCode, PageTextMessage } from "./messages.js";
import type { Clock } from "./reconnect.js";
import { type IssueRoute, parseIssueRoute } from "./route.js";
import { LIMITS } from "./selectors.js";
import { activeTab, corePaused, type Counters, githubCaptureOn, policyAllowsCapture, post, type SharedState } from "./shared-state.js";

/** An approval older than the content script's longest settle (plus slack) is void. */
export const APPROVAL_TTL_MS = LIMITS.maxWaitMs + 5_000;

type Tab = chrome.tabs.Tab;
type Sender = chrome.runtime.MessageSender;
/** A sender that passed senderOk: top frame of a GitHub tab, not incognito. */
export type ContentSender = Sender & { tab: Tab & { id: number }; documentId: string; url: string };

export interface Approval {
  documentId: string;
  navCounter: number;
  routeKey: string;
  at: number;
}

export interface PageTextGate {
  readonly approvals: Map<number, Approval>;
  senderOk(sender: Sender | undefined): sender is ContentSender;
  /** Remember a content-script tab so cancels reach it. */
  noteContentTab(sender: Sender): void;
  onApprove(msg: ApproveRequest, sender: Sender): Promise<ApproveResponse>;
  onPageText(msg: PageTextMessage, sender: Sender): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Stop reads now: bump the cancel epoch, drop every approval, and send
   * cancel to the top frame of each known tab except `except` (a tab about to
   * be asked to refresh). `stop` also disconnects the script (permission revoked).
   */
  cancelTabs(opts?: { stop?: boolean; except?: number | null }): void;
  /** Ask the active tab's script for a fresh capture (when capture is on and the port is open). */
  refreshActive(): Promise<void>;
  /** Chrome's exact GitHub grant and the user's toggle are both on. */
  captureAllowed(): boolean;
  onTabUpdated(tabId: number, url: string | undefined): void;
  onTabRemoved(tabId: number): void;
}

export interface GateDeps {
  ch: typeof chrome;
  clock: Clock;
  state: SharedState;
  counters: Counters;
  /** No port: may start a reconnect series. */
  trigger(): void;
}

const githubOrigin = (u: string): boolean => {
  try {
    return new URL(u).origin === "https://github.com";
  } catch {
    return false;
  }
};

const tabRoute = (t: { url?: string | undefined } | undefined | null): IssueRoute | null =>
  typeof t?.url === "string" ? parseIssueRoute(t.url) : null;

export function createPageTextGate(deps: GateDeps): PageTextGate {
  const { ch, clock, state, counters } = deps;
  const approvals = new Map<number, Approval>();
  const contentTabs = new Set<number>();

  function sendToTab(tabId: number, msg: BackgroundToContent): void {
    Promise.resolve()
      .then(() => ch.tabs.sendMessage(tabId, msg, { frameId: 0 }))
      .catch(() => {});
  }

  async function refreshActive(): Promise<void> {
    if (corePaused(state) || !state.port || !githubCaptureOn(state) || !policyAllowsCapture(state)) return;
    const t = await activeTab(ch).catch(() => null);
    if (!t || t.incognito || t.id === undefined || !tabRoute(t)) return;
    sendToTab(t.id, { type: "refresh" });
  }

  function cancelTabs({ stop = false, except = null }: { stop?: boolean; except?: number | null } = {}): void {
    const ids = new Set([...contentTabs, ...approvals.keys()]);
    state.cancelEpoch++;
    approvals.clear();
    if (stop) contentTabs.clear();
    for (const id of ids) if (id !== except) sendToTab(id, { type: "cancel", stop });
  }

  function senderOk(sender: Sender | undefined): sender is ContentSender {
    return (
      !!sender &&
      sender.id === ch.runtime.id &&
      sender.frameId === 0 &&
      !!sender.tab &&
      Number.isInteger(sender.tab.id) &&
      sender.tab.incognito !== true &&
      typeof sender.documentId === "string" &&
      typeof sender.url === "string" &&
      githubOrigin(sender.url) &&
      (sender.origin === undefined || sender.origin === "https://github.com") &&
      (sender.documentLifecycle === undefined || sender.documentLifecycle === "active")
    );
  }

  const captureAllowed = (): boolean => githubCaptureOn(state);

  /** The browser's record of `tabId` if it is the active tab of the focused, non-incognito window. */
  async function foregroundTab(tabId: number): Promise<Tab | null> {
    if (!state.browserFocused) return null;
    const t = await activeTab(ch);
    if (!t || t.id !== tabId || t.incognito) return null;
    const w = await ch.windows.get(t.windowId);
    return w?.focused === true && w.incognito !== true && state.browserFocused ? t : null;
  }

  const deny = (reason: DenialCode): ApproveResponse => {
    counters.denied++;
    return { approved: false, reason };
  };

  async function onApprove(msg: ApproveRequest, sender: Sender): Promise<ApproveResponse> {
    if (!senderOk(sender)) return deny("sender");
    const route = tabRoute(sender.tab);
    const asked = typeof msg.url === "string" ? parseIssueRoute(msg.url) : null;
    if (!route || !asked || route.key !== asked.key || !Number.isSafeInteger(msg.navCounter)) return deny("route");
    if (corePaused(state)) return deny("paused");
    if (!state.port) {
      deps.trigger();
      return deny("bridge-disconnected");
    }
    if (!policyAllowsCapture(state)) return deny("policy");
    const epoch = state.cancelEpoch;
    if (!captureAllowed()) return deny("permission");
    const fg = await foregroundTab(sender.tab.id).catch(() => null);
    if (!fg) return deny("not-foreground");
    if (tabRoute(fg)?.key !== route.key) return deny("route");
    if (epoch !== state.cancelEpoch || corePaused(state) || !policyAllowsCapture(state)) return deny("cancelled");
    if (!state.port) {
      deps.trigger();
      return deny("bridge-disconnected");
    }
    approvals.set(sender.tab.id, { documentId: sender.documentId, navCounter: msg.navCounter, routeKey: route.key, at: clock.now() });
    return { approved: true };
  }

  function validText(msg: PageTextMessage): boolean {
    return typeof msg.title === "string" && msg.title.length > 0 && typeof msg.text === "string" && typeof msg.truncated === "boolean";
  }

  /** Why a page_text message is dropped, or the route and sender it may be forwarded under. */
  async function checkPageText(msg: PageTextMessage, sender: Sender): Promise<{ reason: string } | { route: IssueRoute; sender: ContentSender; url: string }> {
    if (!senderOk(sender)) return { reason: "sender" };
    const a = approvals.get(sender.tab.id);
    if (!a) return { reason: "no-approval" };
    approvals.delete(sender.tab.id); // single use
    if (clock.now() - a.at > APPROVAL_TTL_MS) return { reason: "expired" };
    if (a.documentId !== sender.documentId) return { reason: "document-changed" };
    const msgRoute = typeof msg.url === "string" ? parseIssueRoute(msg.url) : null;
    if (!msgRoute || a.navCounter !== msg.navCounter || a.routeKey !== msgRoute.key) return { reason: "stale" };
    if (tabRoute(sender.tab)?.key !== msgRoute.key) return { reason: "url-changed" };
    if (corePaused(state)) return { reason: "paused" };
    if (!policyAllowsCapture(state)) return { reason: "policy" };
    if (!captureAllowed()) return { reason: "permission" };
    const fg = await foregroundTab(sender.tab.id).catch(() => null);
    if (!fg) return { reason: "not-foreground" };
    const current = tabRoute(fg);
    if (!current || current.key !== msgRoute.key) return { reason: "url-changed" };
    // The page's own URL, fragment dropped: the core compares it with the focused tab's.
    return { route: current, sender, url: fg.url!.split("#")[0]! };
  }

  async function onPageText(msg: PageTextMessage, sender: Sender): Promise<{ ok: boolean; reason?: string }> {
    const epoch = state.cancelEpoch;
    const drop = (reason: string) => {
      counters.dropped++;
      return { ok: false, reason };
    };
    if (!validText(msg)) return drop("payload");
    const c = await checkPageText(msg, sender);
    if ("reason" in c) return drop(c.reason);
    if (epoch !== state.cancelEpoch || corePaused(state) || !policyAllowsCapture(state)) return drop("cancelled");
    if (!state.port || !state.policy) return drop("bridge-disconnected");
    const obs: PageTextObservation = {
      kind: "page_text",
      seq: state.seq + 1,
      at: clock.now(),
      tabId: c.sender.tab.id,
      documentId: c.sender.documentId,
      url: c.url,
      source: "page",
      title: msg.title,
      text: msg.text,
      truncated: msg.truncated,
      // The core accepts text only under the policy revision it last sent.
      policyRevision: state.policy.revision,
    };
    if (!PageTextObservationSchema.safeParse(obs).success) return drop("payload");
    state.seq++;
    if (!post(state, obs)) return drop("bridge-disconnected");
    counters.forwarded++;
    return { ok: true };
  }

  return {
    approvals,
    senderOk,
    noteContentTab(sender) {
      if (senderOk(sender)) contentTabs.add(sender.tab.id);
    },
    onApprove,
    onPageText,
    cancelTabs,
    refreshActive,
    captureAllowed,
    onTabUpdated(tabId, url) {
      const a = approvals.get(tabId);
      if (a && url !== undefined && parseIssueRoute(url)?.key !== a.routeKey) approvals.delete(tabId);
    },
    onTabRemoved(tabId) {
      approvals.delete(tabId);
      contentTabs.delete(tabId);
    },
  };
}
