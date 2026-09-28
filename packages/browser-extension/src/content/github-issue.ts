// Content-script entry, registered on all of https://github.com/* after the
// GitHub grant (GitHub moves from repo home to Issues to an issue without a
// page load, so a script matched only to issue URLs would never be injected).
// Bundled as a classic script (IIFE): registered content scripts cannot be
// modules. It only watches the URL; see capture.ts for when it reads text.

import type { ApproveResponse, BackgroundToContent, ContentToBackground } from "../messages.js";
import { type CaptureController, createCaptureController, type NavigationLike } from "./capture.js";

interface Holder {
  ctl: CaptureController | null;
  listening: boolean;
}

type ContentChrome = {
  runtime: Pick<typeof chrome.runtime, "id" | "sendMessage" | "onMessage">;
};

const HOLDER_KEY = "__scoutGithubIssue";

/**
 * One live controller per page: re-injection is a no-op while it runs, and
 * starts a fresh one after a revoke stopped it.
 */
export function startContentScript(ch: ContentChrome, win: Window): CaptureController | null {
  const g = win as unknown as Record<string, Holder | undefined>;
  const holder: Holder = g[HOLDER_KEY] ?? (g[HOLDER_KEY] = { ctl: null, listening: false });
  if (holder.ctl && !holder.ctl.stopped) return null;
  let ctl: CaptureController | null = null;
  const send = async <R>(msg: ContentToBackground): Promise<R> => {
    try {
      return (await ch.runtime.sendMessage(msg)) as R;
    } catch (e) {
      // Extension reloaded or messaging unavailable: fail closed.
      ctl?.stop();
      throw e;
    }
  };
  const navigation = (win as unknown as { navigation?: NavigationLike }).navigation ?? null;
  ctl = createCaptureController({
    win,
    doc: win.document,
    navigation,
    requestApproval: (m) => send<ApproveResponse>({ type: "approve", navCounter: m.navCounter, url: m.url }),
    sendPageText: (m) => send(m),
    alive: () => !!ch.runtime?.id, // extension reloaded: this script is orphaned
  });
  holder.ctl = ctl;
  if (!holder.listening) {
    holder.listening = true;
    ch.runtime.onMessage.addListener((msg: BackgroundToContent, sender) => {
      if (sender?.id !== ch.runtime.id || !holder.ctl) return;
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

if (typeof chrome !== "undefined" && chrome.runtime?.id) startContentScript(chrome, window);
