import { describe, expect, it } from "vitest";
import { createBackground, GITHUB_PATTERN } from "./background-core.js";
import type { PanelState } from "@scout/contracts";
import { createPortLink, SERIES_KEY } from "./port.js";
import { createSharedState, newCounters } from "./shared-state.js";
import { RECONNECT_DELAYS_MS, type SeriesState } from "./reconnect.js";
import { asChrome, fakeClock, flush, makeChrome } from "./test-fakes.js";
import { approve, dropPort, lastPort, setup } from "./test-harness.js";

const LONG = 10 * 60_000;

describe("bounded reconnect (fake port and clock)", () => {
  it("runs 1, 2, 4, 8, 16, 30 s, then makes no attempt until a focus event", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN], host: "missing" });
    const clock = fakeClock();
    const bg = createBackground(asChrome(f), { clock });
    await bg.start();
    expect(f._.ports).toHaveLength(1);
    for (const [i, d] of RECONNECT_DELAYS_MS.entries()) {
      await clock.advance(d - 1);
      expect(f._.ports).toHaveLength(i + 1);
      await clock.advance(1);
      expect(f._.ports).toHaveLength(i + 2);
    }
    await clock.advance(LONG);
    expect(f._.ports).toHaveLength(7);
    expect(bg.snapshot().link).toBe("disconnected");
    await Promise.all(f.windows.onFocusChanged.emit(1 as never));
    await clock.advance(0);
    expect(f._.ports).toHaveLength(8);
  });

  it("a ready port that drops twice within 60 s does not get a second fresh series", async () => {
    const { f, clock, bg } = await setup();
    await clock.advance(10_000);
    dropPort(f); // healthy, but a fresh series is not allowed yet: continues at 1 s
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(2);
    await clock.advance(10_000);
    dropPort(f); // still within 60 s of the series start: next delay is 2 s, not 1 s
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(2);
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(3);
    expect(bg.policy.seriesStarted).toBe(1);
  });

  it("a port that never said ready is not healthy, however long it stayed open", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], host: "silent" });
    expect(bg.snapshot().link).toBe("connecting");
    await clock.advance(2 * 60_000);
    dropPort(f); // > 60 s since the series began, but not healthy: continue, no fresh series
    expect(bg.policy.seriesStarted).toBe(1);
    expect(bg.policy.step).toBe(1);
  });

  it("the panel's Reconnect starts a series at once, even within 60 s", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await clock.advance(LONG);
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(0);
    const n = f._.ports.length;
    await bg.panelRequest({ type: "reconnect" });
    expect(f._.ports).toHaveLength(n + 1);
  });

  it("shows connecting until ready, core unavailable when the host reports it, connected again on an ack", async () => {
    const { f, bg } = await setup({ granted: [GITHUB_PATTERN], host: "silent" });
    expect(bg.snapshot().link).toBe("connecting");
    lastPort(f).onMessage.emit({ type: "ready" });
    expect(bg.snapshot().link).toBe("connected");
    lastPort(f).onMessage.emit({ type: "core_unavailable" });
    expect(bg.snapshot().link).toBe("core_unavailable");
    lastPort(f).onMessage.emit({ type: "ack", seq: 1 });
    expect(bg.snapshot().link).toBe("connected");
    lastPort(f).onMessage.emit({ type: "bogus" });
    expect(bg.snapshot().counters.acked).toBe(1);
  });

  it("denies approval while no port is open", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await clock.advance(1);
    await flush();
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "bridge-disconnected" });
  });
});

describe("reconnect across service-worker restarts", () => {
  /** A new worker: fresh fake chrome and background, same session storage, clock continuing. */
  async function restart(session: Record<string, unknown>, at: number) {
    const f = makeChrome({ granted: [GITHUB_PATTERN], host: "missing", session });
    const clock = fakeClock(at);
    const bg = createBackground(asChrome(f), { clock });
    await bg.start();
    return { f, clock, bg };
  }

  it("resumes a series mid-schedule at its step", async () => {
    const first = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await first.clock.advance(1000 + 2000); // attempts at 0, 1, 3 s; the 4 s retry is pending
    expect(first.f._.ports).toHaveLength(3);
    const { f, clock, bg } = await restart(first.f._.session, first.clock.now() + 1000);
    expect(f._.ports).toHaveLength(0);
    expect(bg.snapshot().link).toBe("connecting");
    await clock.advance(3000 - 1 - 150); // the pending retry keeps its original due time
    expect(f._.ports).toHaveLength(0);
    await clock.advance(1);
    expect(f._.ports).toHaveLength(1);
    await clock.advance(8000 - 1); // next step is 8 s, not a fresh 1 s
    expect(f._.ports).toHaveLength(1);
    await clock.advance(1);
    expect(f._.ports).toHaveLength(2);
    expect(bg.policy.seriesStarted).toBe(0);
  });

  it("refuses a new series within 60 s of the last one, then allows one on an event", async () => {
    const session: Record<string, unknown> = {};
    const t0 = 5_000_000;
    session[SERIES_KEY] = { seriesStartedAt: t0 - 20_000, step: RECONNECT_DELAYS_MS.length, exhausted: true, retryAt: null } satisfies SeriesState;
    const { f, clock, bg } = await restart(session, t0);
    expect(f._.ports).toHaveLength(0);
    expect(bg.snapshot().link).toBe("disconnected");
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(30_000);
    expect(f._.ports).toHaveLength(0);
    await clock.advance(10_000); // 60 s since the series began
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(0);
    expect(f._.ports).toHaveLength(1);
  });

  it("connects at once on wake when the last series began over 60 s ago", async () => {
    const session: Record<string, unknown> = {};
    session[SERIES_KEY] = { seriesStartedAt: 1_000, step: 2, exhausted: false, retryAt: null } satisfies SeriesState;
    const { f } = await restart(session, 5_000_000);
    expect(f._.ports).toHaveLength(1);
  });
});

describe("window frames and commands over the port (bridge protocol 3)", () => {
  async function link(host: "ok" | "silent" = "ok") {
    const f = makeChrome({ granted: [GITHUB_PATTERN], host });
    const clock = fakeClock();
    const state = createSharedState(clock);
    const panel: PanelState[] = [];
    const l = createPortLink({
      ch: asChrome(f),
      clock,
      state,
      counters: newCounters(),
      onOpen: () => {},
      onPolicy: () => {},
      onLost: () => {},
      onPanel: (frame) => void panel.push(frame),
    });
    await l.start();
    await flush();
    return { f, l, panel };
  }
  const pause = { type: "pause" } as const;

  it("hands each valid panel frame to onPanel, unwrapped, and ignores invalid ones", async () => {
    const { f, panel } = await link();
    const grant = { type: "grant", agentBrowserContext: true } as const;
    f._.ports[0]!.onMessage.emit({ type: "panel", state: grant });
    f._.ports[0]!.onMessage.emit({ type: "panel", state: { type: "results", status: "ok" } });
    f._.ports[0]!.onMessage.emit({ type: "panel", state: { type: "ready" } });
    expect(panel).toEqual([grant]);
  });

  it("without an onPanel hook a panel frame is ignored", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN], host: "ok" });
    const clock = fakeClock();
    const l = createPortLink({ ch: asChrome(f), clock, state: createSharedState(clock), counters: newCounters(), onOpen: () => {}, onPolicy: () => {}, onLost: () => {} });
    await l.start();
    await flush();
    expect(() => f._.ports[0]!.onMessage.emit({ type: "panel", state: { type: "grant", agentBrowserContext: false } })).not.toThrow();
    expect(l.linkState()).toBe("connected");
  });

  it("posts a validated command frame once ready, and nothing before or for an invalid command", async () => {
    const { f, l } = await link("silent");
    expect(l.sendCommand(pause)).toBe(false); // open, not ready: never queued
    f._.ports[0]!.onMessage.emit({ type: "ready" });
    expect(l.sendCommand(pause)).toBe(true);
    const openLink = { type: "open_link", commandId: "sp-1", coreInstanceId: "core-1", visitEpoch: 2, jobId: "job-1", candidateId: "c1" } as const;
    expect(l.sendCommand(openLink)).toBe(true);
    expect(l.sendCommand({ type: "frontmost", bundleId: "x", at: 1 } as never)).toBe(false);
    expect(l.sendCommand({ type: "approve", commandId: "bad id!" } as never)).toBe(false);
    expect(f._.ports[0]!.posted).toEqual([
      { type: "command", command: pause },
      { type: "command", command: openLink },
    ]);
  });

  it("refuses a command once the port is gone", async () => {
    const { f, l } = await link();
    expect(l.sendCommand(pause)).toBe(true);
    const p = f._.ports[0]!;
    p.disconnected = true;
    p.onDisconnect.emit(p);
    expect(l.sendCommand(pause)).toBe(false);
  });
});
