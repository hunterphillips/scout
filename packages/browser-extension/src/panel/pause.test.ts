// Ported from ScoutKit's PauseStateTests.swift. The core is the one source of
// truth, as in the app; browser differences: no quitting state, and a pending request expires
// after PAUSE_PENDING_MS.
import { describe, expect, it } from "vitest";
import { PAUSE_PENDING_MS, PauseState } from "./pause.js";

const PAUSE = { title: "Pause", enabled: true, label: "Pause Scout", pause: true };
const RESUME = { title: "Resume", enabled: true, label: "Resume Scout", pause: false };
const PAUSING = { title: "Pausing…", enabled: false, label: "Pausing Scout", pause: true };
const RESUMING = { title: "Resuming…", enabled: false, label: "Resuming Scout", pause: false };
const OFF = { ...PAUSE, enabled: false };

const at = (core: PauseState["core"]) => {
  const s = new PauseState();
  if (core) s.apply(core);
  return s;
};

describe("PauseState (PauseStateTests.swift)", () => {
  it("followsTheCoresStateFrame", () => {
    const s = new PauseState();
    expect(s.control).toEqual(OFF); // no core has reported: nothing to pause
    expect(s.request()).toBeNull();
    s.apply("idle");
    expect(s.control).toEqual(PAUSE);
    s.apply("working");
    expect(s.control).toEqual(PAUSE);
    s.apply("paused");
    expect(s.control).toEqual(RESUME);
    expect(s.request()).toBe(false);
    s.apply("disconnected");
    expect(s.control).toEqual(OFF);
  });

  it("aRequestIsPendingUntilAFrameShowsItsTarget", () => {
    const s = at("idle");
    expect(s.request()).toBe(true);
    s.sent(true, true);
    expect(s.control).toEqual(PAUSING);
    expect(s.request()).toBeNull();
    s.apply("working"); // emitted before the core read the pause
    expect(s.control).toEqual(PAUSING);
    s.apply("paused");
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(RESUME);
    expect(s.request()).toBe(false);
    s.sent(false, true);
    expect(s.control).toEqual(RESUMING);
    s.apply("paused");
    expect(s.control).toEqual(RESUMING);
    s.apply("disconnected");
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(OFF);
  });

  it("aChangeMadeElsewhereSettlesTheRequest", () => {
    const s = at("working");
    s.request();
    s.sent(true, true);
    s.apply("paused"); // the Mac menu paused it meanwhile
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(RESUME);
  });

  it("aRefusedWriteSettlesAtOnce", () => {
    const s = at("paused");
    expect(s.request()).toBe(false);
    s.sent(false, false);
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(RESUME);
  });

  it("aStoppedOrRestartedCoreSettlesWithoutResending", () => {
    const s = at("idle");
    s.request();
    s.sent(true, true);
    s.coreStopped();
    expect(s.pending).toBeNull();
    expect(s.core).toBeNull();
    s.apply("idle");
    s.request();
    s.sent(true, true);
    s.coreRestarted();
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(PAUSE);
    s.apply("paused");
    expect(s.control).toEqual(RESUME);
  });

  it("shows only the core's state: paused anywhere shows Resume, resumed anywhere shows Pause", () => {
    const s = at("idle");
    s.sent(true, true); // the panel paused
    s.apply("paused");
    expect(s.paused).toBe(true);
    expect(s.control).toEqual(RESUME);
    s.apply("idle"); // the Mac menu resumed
    expect(s.paused).toBe(false);
    expect(s.control).toEqual(PAUSE);
  });

  it("a pending request no frame confirms expires to the core's state", () => {
    const s = at("idle");
    s.sent(true, true, 5_000);
    s.expire(5_000 + PAUSE_PENDING_MS - 1);
    expect(s.control).toEqual(PAUSING);
    s.expire(5_000 + PAUSE_PENDING_MS);
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(PAUSE);
    const r = at("paused");
    r.sent(false, true, 0);
    r.expire(PAUSE_PENDING_MS);
    expect(r.control).toEqual(RESUME);
  });
});
