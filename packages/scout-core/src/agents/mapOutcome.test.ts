import { describe, expect, it } from "vitest";
import type { JobDetails } from "./adapter.js";
import { mapOutcome, type CliRun } from "./mapOutcome.js";

const MARKER = "SCOUTMARK0123456789ab";
const req = { candidates: [{ id: "c1", title: "A", labelQuality: "published" as const }, { id: "c2", title: "B", labelQuality: "published" as const }], maxPicks: 3 };

const details = (): JobDetails => ({ adapter: "claude-code", termination: "completed", toolUses: [], optionalTools: [], droppedPicks: 0, cutPicks: 0, toolErrors: {}, optionalToolFailed: false, timings: { totalMs: 0 }, usage: {} });

const run = (items: { id: string; reason: string }[]): CliRun => ({
  spawnError: false,
  stop: undefined,
  init: { type: "system", subtype: "init" },
  result: { type: "result", subtype: "success", is_error: false, structured_output: { status: "ok", items } },
});

describe("mapOutcome: the instruction marker", () => {
  it("strips the marker from the first reason", () => {
    const d = details();
    const out = mapOutcome(run([{ id: "c1", reason: `${MARKER} Fits` }]), req, d, MARKER);
    expect(out.result).toEqual({ status: "ok", items: [{ id: "c1", reason: "Fits" }] });
    expect(d.instructionMarker).toBe("reached");
  });

  it("drops a first pick whose reason was only the marker", () => {
    const d = details();
    const out = mapOutcome(run([{ id: "c1", reason: MARKER }, { id: "c2", reason: "Fits" }]), req, d, MARKER);
    expect(out.result).toEqual({ status: "ok", items: [{ id: "c2", reason: "Fits" }] });
    expect(d).toMatchObject({ instructionMarker: "reached", droppedPicks: 1 });
    expect(JSON.stringify(out)).not.toContain(MARKER);
  });

  it("a sole pick that was only the marker is invalid output, never empty", () => {
    const d = details();
    const out = mapOutcome(run([{ id: "c1", reason: MARKER }]), req, d, MARKER);
    expect(out).toMatchObject({ result: { status: "error", reason: "invalid_output" }, termination: "invalid_output" });
    expect(d.droppedPicks).toBe(1);
    expect(JSON.stringify(out)).not.toContain(MARKER);
  });

  it("leaves reasons alone when no marker is probed", () => {
    const out = mapOutcome(run([{ id: "c1", reason: MARKER }]), req, details());
    expect(out.result).toEqual({ status: "ok", items: [{ id: "c1", reason: MARKER }] });
  });
});

describe("mapOutcome: order", () => {
  it("a stop wins over a valid result; a spawn failure wins over everything", () => {
    const stop = { result: { status: "cancelled" as const, reason: "superseded" as const }, termination: "cancelled" as const };
    expect(mapOutcome({ ...run([{ id: "c1", reason: "Fits" }]), stop }, req, details()).result).toEqual(stop.result);
    expect(mapOutcome({ ...run([{ id: "c1", reason: "Fits" }]), stop, spawnError: true }, req, details())).toMatchObject({ termination: "agent_unavailable", detail: "spawn_failed" });
  });
});
