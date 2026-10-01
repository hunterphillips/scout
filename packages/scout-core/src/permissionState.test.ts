import type { FocusObservation, PermissionsObservation } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createPermissionState, patternToOrigin } from "./permissionState.js";

function setup() {
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  return { events, state: createPermissionState({ diagnostics }) };
}

const snapshot = (revision: number, granted: string[], githubCapture = false): PermissionsObservation => ({
  kind: "permissions",
  revision,
  at: 1,
  granted,
  githubCapture,
});

const focus = (permissionsRevision?: number): FocusObservation => ({
  kind: "focus",
  seq: 1,
  at: 1,
  browserFocused: true,
  windowId: 1,
  ...(permissionsRevision === undefined ? {} : { permissionsRevision }),
});

describe("permissionState", () => {
  it("permits nothing and disables GitHub capture before the first snapshot", () => {
    const { state } = setup();
    expect(state.received).toBe(false);
    expect(state.revision).toBeNull();
    expect(state.githubCapture).toBe(false);
    expect(state.isPermitted("https://github.com")).toBe(false);
    // Focus is accepted (it carries Chrome focus) even though nothing is permitted yet.
    expect(state.acceptsFocus(focus())).toBe(true);
    expect(state.acceptsFocus(focus(3))).toBe(true);
  });

  it("converts granted patterns to exact origins", () => {
    const { state } = setup();
    expect(state.applySnapshot(snapshot(5, ["https://docs.stripe.com/*", "https://github.com/*"], true))).toBe(true);
    expect(state.received).toBe(true);
    expect(state.revision).toBe(5);
    expect(state.githubCapture).toBe(true);
    expect(state.isPermitted("https://docs.stripe.com")).toBe(true);
    expect(state.isPermitted("https://github.com")).toBe(true);
    expect(state.isPermitted("https://stripe.com")).toBe(false);
    expect(state.isPermitted("https://docs.stripe.com:8443")).toBe(false);
    expect(state.isPermitted("https://docs.stripe.com/*")).toBe(false);
    expect(patternToOrigin("https://docs.stripe.com/*")).toBe("https://docs.stripe.com");
  });

  it("each snapshot replaces the previous one wholesale", () => {
    const { state } = setup();
    state.applySnapshot(snapshot(1, ["https://a.example/*", "https://github.com/*"], true));
    state.applySnapshot(snapshot(2, ["https://b.example/*"], false));
    expect(state.isPermitted("https://a.example")).toBe(false);
    expect(state.isPermitted("https://github.com")).toBe(false);
    expect(state.isPermitted("https://b.example")).toBe(true);
    expect(state.githubCapture).toBe(false);
  });

  it("drops a snapshot with a lower revision; an equal one replaces", () => {
    const { state, events } = setup();
    state.applySnapshot(snapshot(10, ["https://a.example/*"]));
    expect(state.applySnapshot(snapshot(9, ["https://b.example/*"]))).toBe(false);
    expect(state.isPermitted("https://a.example")).toBe(true);
    expect(state.isPermitted("https://b.example")).toBe(false);
    expect(events.at(-1)).toEqual({ name: "permissions_dropped", fields: { reason: "stale_permissions_revision", revision: 9 } });
    expect(state.applySnapshot(snapshot(10, ["https://c.example/*"]))).toBe(true);
    expect(state.isPermitted("https://c.example")).toBe(true);
  });

  it("drops a focus stamped with an older permissions revision", () => {
    const { state, events } = setup();
    state.applySnapshot(snapshot(7, []));
    expect(state.acceptsFocus(focus(6))).toBe(false);
    expect(events.at(-1)).toEqual({ name: "focus_dropped", fields: { reason: "stale_permissions_revision", revision: 6 } });
    expect(state.acceptsFocus(focus(7))).toBe(true);
    expect(state.acceptsFocus(focus())).toBe(true);
  });

  it("drops a focus stamped ahead of the current snapshot until that snapshot arrives", () => {
    const { state, events } = setup();
    state.applySnapshot(snapshot(7, ["https://a.example/*"]));
    // Snapshot 8 (which revoked a.example, say) was lost on the way: fail closed.
    expect(state.acceptsFocus(focus(8))).toBe(false);
    expect(events.at(-1)).toEqual({ name: "focus_dropped", fields: { reason: "permissions_ahead", revision: 8 } });
    state.applySnapshot(snapshot(8, []));
    expect(state.acceptsFocus(focus(8))).toBe(true);
  });

  it("clear forgets the snapshot and its revision", () => {
    const { state } = setup();
    state.applySnapshot(snapshot(7, ["https://github.com/*"], true));
    state.clear();
    expect(state.received).toBe(false);
    expect(state.revision).toBeNull();
    expect(state.githubCapture).toBe(false);
    expect(state.isPermitted("https://github.com")).toBe(false);
    // A new connection may start from a lower revision.
    expect(state.applySnapshot(snapshot(1, ["https://github.com/*"]))).toBe(true);
  });

  it("logs counts and the revision, never origins", () => {
    const { state, events } = setup();
    state.applySnapshot(snapshot(3, ["https://docs.stripe.com/*", "https://github.com/*"], true));
    expect(events).toEqual([{ name: "permissions", fields: { revision: 3, granted: 2, githubCapture: true } }]);
  });
});
