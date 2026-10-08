import { afterEach, describe, expect, it, vi } from "vitest";
import { docsPage, EXT_ID, flush, makeDom, trackerPage } from "../test-fakes.js";
import { startContentScript } from "./page.js";

const ISSUE1 = "https://tracker.example/acme/widgets/issues/1";

function fakeRuntime(sendMessage: (m: unknown) => Promise<unknown>) {
  const listeners: unknown[] = [];
  const runtime = {
    id: EXT_ID as string | undefined,
    sendMessage,
    onMessage: { addListener: (f: unknown) => void listeners.push(f) },
  };
  return { ch: { runtime } as unknown as Parameters<typeof startContentScript>[0], runtime, listeners };
}

describe("content-script entry", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of cleanups.splice(0)) c();
  });

  it("re-injection into a page with a live controller is a no-op", () => {
    const d = makeDom("https://docs.example/billing", docsPage());
    const { ch, listeners } = fakeRuntime(async () => ({ approved: false }));
    const ctl = startContentScript(ch, d.win)!;
    cleanups.push(() => (ctl.stop(), d.close()));
    expect(ctl).not.toBeNull();
    expect(startContentScript(ch, d.win)).toBeNull();
    expect(listeners).toHaveLength(1);
  });

  it("stops the controller when sendMessage throws (extension reloaded)", async () => {
    const d = makeDom(ISSUE1, trackerPage());
    const { ch } = fakeRuntime(async () => {
      throw new Error("Extension context invalidated.");
    });
    const ctl = startContentScript(ch, d.win)!;
    cleanups.push(() => (ctl.stop(), d.close()));
    await flush();
    expect(ctl.stopped).toBe(true);
    expect(ctl.state.extractions).toBe(0);
  });

  it("stops on the next poll tick once chrome.runtime.id is gone", () => {
    vi.useFakeTimers();
    const d = makeDom("https://docs.example/billing", docsPage());
    const { ch, runtime } = fakeRuntime(async () => ({ approved: false }));
    const ctl = startContentScript(ch, d.win)!;
    cleanups.push(() => (ctl.stop(), d.close()));
    runtime.id = undefined;
    vi.advanceTimersByTime(1000);
    expect(ctl.stopped).toBe(true);
  });
});
