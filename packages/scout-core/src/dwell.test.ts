import type { ActiveVisit } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { Timers } from "./clock.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createDwellScheduler, DWELL_MS, type DwellCancelReason } from "./dwell.js";

/** One-shot timers on a manual clock. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return {
    timers,
    advance,
    pending: () => pending.size,
  };
}

const visit = (epoch: number, origin = "https://docs.stripe.com"): ActiveVisit => ({
  epoch,
  tabId: 1,
  origin,
  url: `${origin}/x`,
  startedAt: 0,
  contextRevision: 0,
});

function setup() {
  const t = fakeTimers();
  const settled: ActiveVisit[] = [];
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const dwell = createDwellScheduler({ timers: t.timers, diagnostics, onSettled: (v) => void settled.push(v) });
  return { ...t, settled, events, dwell };
}

describe("dwell scheduler", () => {
  it("settles a visit after DWELL_MS, exactly once", () => {
    const s = setup();
    const v = visit(1);
    s.dwell.arm(v);
    s.advance(DWELL_MS - 1);
    expect(s.settled).toEqual([]);
    s.advance(1);
    expect(s.settled).toEqual([v]);
    s.advance(DWELL_MS * 3);
    expect(s.settled).toHaveLength(1);
    expect(s.dwell.armedEpoch).toBeNull();
    expect(s.events.filter((e) => e.name === "dwell_settled")).toEqual([{ name: "dwell_settled", fields: { epoch: 1 } }]);
  });

  it("re-arming the same visit keeps the original deadline", () => {
    const s = setup();
    s.dwell.arm(visit(1));
    s.advance(2000);
    s.dwell.arm(visit(1));
    s.advance(1000);
    expect(s.settled).toHaveLength(1);
  });

  it("a different visit restarts the dwell and cancels the old one as visit_changed", () => {
    const s = setup();
    s.dwell.arm(visit(1));
    s.advance(2000);
    s.dwell.arm(visit(2));
    s.advance(2000);
    expect(s.settled).toEqual([]);
    s.advance(1000);
    expect(s.settled.map((v) => v.epoch)).toEqual([2]);
    expect(s.events.find((e) => e.name === "dwell_cancelled")?.fields).toEqual({ epoch: 1, reason: "visit_changed" });
    expect(s.pending()).toBe(0);
  });

  it.each<DwellCancelReason>(["visit_ended", "paused", "permission_lost", "disconnected"])("cancel(%s) stops the settle", (reason) => {
    const s = setup();
    s.dwell.arm(visit(1));
    s.advance(DWELL_MS - 1);
    s.dwell.cancel(reason);
    s.advance(DWELL_MS * 2);
    expect(s.settled).toEqual([]);
    expect(s.pending()).toBe(0);
    expect(s.events.filter((e) => e.name === "dwell_cancelled").map((e) => e.fields)).toEqual([{ epoch: 1, reason }]);
  });

  it("can re-arm after a cancel, including the same visit (resume)", () => {
    const s = setup();
    s.dwell.arm(visit(1));
    s.dwell.cancel("paused");
    s.dwell.arm(visit(1));
    s.advance(DWELL_MS);
    expect(s.settled.map((v) => v.epoch)).toEqual([1]);
  });

  it("cancel with nothing armed is silent", () => {
    const s = setup();
    s.dwell.cancel("paused");
    expect(s.events).toEqual([]);
  });

  it("stop cancels and refuses later arms", () => {
    const s = setup();
    s.dwell.arm(visit(1));
    s.dwell.stop();
    s.dwell.stop();
    s.dwell.arm(visit(2));
    s.advance(DWELL_MS * 2);
    expect(s.settled).toEqual([]);
    expect(s.events.filter((e) => e.name === "dwell_cancelled").map((e) => e.fields)).toEqual([{ epoch: 1, reason: "stopped" }]);
  });

  it("a throwing onSettled is caught and logged", () => {
    const t = fakeTimers();
    const names: string[] = [];
    const dwell = createDwellScheduler({
      timers: t.timers,
      diagnostics: { failures: 0, event: (n) => void names.push(n) },
      onSettled: () => {
        throw new Error("boom");
      },
    });
    dwell.arm(visit(1));
    expect(() => t.advance(DWELL_MS)).not.toThrow();
    expect(names).toContain("dwell_settled_handler_error");
  });
});
