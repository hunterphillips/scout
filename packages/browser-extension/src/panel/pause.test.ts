// Ported from ScoutKit's PauseStateTests.swift (P4.2, on main). Browser differences: the control
// also pauses the extension's own posting, so it stays enabled with no core to reach (the app's
// is disabled then), and there is no quitting state.
import { describe, expect, it } from "vitest";
import { PauseState } from "./pause.js";

const PAUSE = { title: "Pause", enabled: true, label: "Pause Scout", pause: true };
const RESUME = { title: "Resume", enabled: true, label: "Resume Scout", pause: false };
const PAUSING = { title: "Pausing…", enabled: false, label: "Pausing Scout", pause: true };
const RESUMING = { title: "Resuming…", enabled: false, label: "Resuming Scout", pause: false };

const at = (core: PauseState["core"]) => {
  const s = new PauseState();
  if (core) s.apply(core);
  return s;
};

describe("PauseState (PauseStateTests.swift)", () => {
  it("followsTheCoresStateFrame", () => {
    const s = new PauseState();
    expect(s.control).toEqual(PAUSE); // the extension can always pause itself
    s.apply("idle");
    expect(s.control).toEqual(PAUSE);
    s.apply("working");
    expect(s.control).toEqual(PAUSE);
    s.apply("paused");
    expect(s.control).toEqual(RESUME);
    expect(s.request()).toBe(false);
    s.apply("disconnected");
    expect(s.control).toEqual(PAUSE);
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
    expect(s.control).toEqual(PAUSE);
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

  it("with no core, a click still pauses and resumes the extension, and nothing is pending", () => {
    const s = new PauseState();
    expect(s.request()).toBe(true);
    s.sent(true, false); // no ready port: the core was not told
    s.extPaused = true; // the worker's reply
    expect(s.pending).toBeNull();
    expect(s.control).toEqual(RESUME);
    expect(s.request()).toBe(false);
  });

  it("either side paused shows Resume; resuming targets both", () => {
    const s = at("idle");
    s.extPaused = true;
    expect(s.control).toEqual(RESUME);
    s.extPaused = false;
    s.apply("paused");
    expect(s.control).toEqual(RESUME);
    // A resume to a core that is already running settles at once.
    const r = at("idle");
    r.extPaused = true;
    r.sent(false, true);
    expect(r.pending).toBeNull();
  });
});
