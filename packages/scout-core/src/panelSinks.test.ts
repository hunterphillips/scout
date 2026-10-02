import type { BrowserObservation, PanelState, RelayCommand, ToChromeFrame } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { emptyState } from "./capabilities/decisions.js";
import { createCoordinator } from "./coordinator.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createPanelChannel, type PanelStore } from "./panelChannel.js";
import { createPanelSinks, type PanelSink } from "./panelSinks.js";
import { createResultRegistry } from "./results.js";
import type { SocketClient, SocketClientFrame } from "./socketServer.js";

function spy() {
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  return { events, diagnostics };
}

function recordingSink(id: string, kind: PanelSink["kind"]) {
  const frames: PanelState[] = [];
  const sink: PanelSink = { id, kind, send: (f) => void frames.push(f) };
  return { sink, frames };
}

const ack = (commandId: string): PanelState => ({ type: "ack", commandId, ok: true, revision: 0, approvalRevision: 0 });
const GRANT: PanelState = { type: "grant", agentBrowserContext: false };

describe("panel sinks", () => {
  it("fans every frame out to every sink and routes a command's answer only to its sender", () => {
    const { diagnostics, events } = spy();
    const sinks = createPanelSinks({ diagnostics });
    const app = recordingSink("stdio", "stdio");
    const side = recordingSink("relay-1", "relay");
    sinks.add(app.sink);
    sinks.add(side.sink);
    sinks.emit(GRANT);
    sinks.routeCommand("a1", app.sink);
    sinks.routeCommand("s1", side.sink);
    sinks.emit(ack("s1"));
    sinks.emit(ack("a1"));
    const chunk = { type: "preview", commandId: "s1" } as unknown as PanelState;
    sinks.emit(chunk);
    expect(app.frames).toEqual([GRANT, ack("a1")]);
    expect(side.frames).toEqual([GRANT, ack("s1"), chunk]);
    expect(events).toEqual([]);
  });

  it("drops an answer with no route or whose sink is gone, with a scalar event", () => {
    const { diagnostics, events } = spy();
    const sinks = createPanelSinks({ diagnostics });
    const side = recordingSink("relay-1", "relay");
    sinks.add(side.sink);
    sinks.routeCommand("s1", side.sink);
    sinks.remove(side.sink);
    sinks.remove(side.sink); // idempotent
    sinks.emit(ack("s1"));
    sinks.emit(ack("nobody"));
    expect(side.frames).toEqual([]);
    expect(events).toEqual([
      { name: "panel_ack_dropped", fields: { type: "ack", reason: "sink_gone" } },
      { name: "panel_ack_dropped", fields: { type: "ack", reason: "no_route" } },
    ]);
  });

  it("keeps a bounded route map, oldest first out; a re-sent id becomes the newest", () => {
    const { diagnostics } = spy();
    const sinks = createPanelSinks({ diagnostics, routeLimit: 2 });
    const app = recordingSink("stdio", "stdio");
    sinks.add(app.sink);
    sinks.routeCommand("a", app.sink);
    sinks.routeCommand("b", app.sink);
    sinks.routeCommand("a", app.sink); // a is now newer than b
    sinks.routeCommand("c", app.sink); // evicts b
    for (const id of ["a", "b", "c"]) sinks.emit(ack(id));
    expect(app.frames).toEqual([ack("a"), ack("c")]);
  });

  it("a sink that throws does not stop the others", () => {
    const { diagnostics, events } = spy();
    const sinks = createPanelSinks({ diagnostics });
    const bad: PanelSink = {
      id: "relay-1",
      kind: "relay",
      send: () => {
        throw new Error("closed");
      },
    };
    const app = recordingSink("stdio", "stdio");
    sinks.add(bad);
    sinks.add(app.sink);
    sinks.emit(GRANT);
    expect(app.frames).toEqual([GRANT]);
    expect(events).toEqual([{ name: "panel_emit_failed", fields: { sink: "relay" } }]);
  });
});

// The core's wiring as main.ts builds it: the coordinator, the panel channel, the sinks (stdio
// registered at start) and the result registry, with fake native-host connections.
const emptyStore = {
  snapshot: () => emptyState(),
  getResource: () => undefined,
  originPolicy: () => undefined,
  readBlob: () => Buffer.alloc(0),
  pinForPreview: () => false,
  releasePins: () => {},
  approve: async () => {
    throw new Error("unused");
  },
  decline: async () => {
    throw new Error("unused");
  },
  revoke: async () => {
    throw new Error("unused");
  },
  setOriginPolicy: async () => {
    throw new Error("unused");
  },
  approvalRevision: 0,
} satisfies PanelStore;

function fakeClient(id: number) {
  const handlers: Array<(f: SocketClientFrame) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const sent: ToChromeFrame[] = [];
  const client: SocketClient = {
    id,
    send: (f) => void sent.push(f),
    onFrame: (h) => void handlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    close: () => {},
  };
  return {
    client,
    sent,
    /** The panel frames this connection got, unwrapped. */
    panel: (): PanelState[] => sent.flatMap((f) => (f.type === "panel" ? [f.state] : [])),
    frame: (f: SocketClientFrame) => {
      for (const h of handlers) h(f);
    },
    command: (command: RelayCommand) => {
      for (const h of handlers) h({ type: "command", command });
    },
    observe: (observation: BrowserObservation) => {
      for (const h of handlers) h({ type: "observation", observation });
    },
    disconnect: () => {
      for (const h of closeHandlers) h();
    },
  };
}

function wiring() {
  const { diagnostics, events } = spy();
  const clock = { now: () => 1_000 };
  const sinks = createPanelSinks({ diagnostics });
  const app = recordingSink("stdio", "stdio");
  sinks.add(app.sink);
  const emitPanel = (f: PanelState): void => sinks.emit(f);
  const pending: Array<() => void> = [];
  const timers = { setTimeout: (fn: () => void) => (pending.push(fn), pending.length), clearTimeout: () => {} };
  let coordinator: ReturnType<typeof createCoordinator>;
  const results = createResultRegistry({ coreInstanceId: "core-test", activeVisit: () => null, isPermitted: () => false, diagnostics });
  const channel = createPanelChannel({
    store: emptyStore,
    coreInstanceId: "core-test",
    exportConflicts: () => [],
    readBrowserContextGrant: () => false,
    writeBrowserContextGrant: () => ({ restore: () => {} }),
    getAudit: () => [],
    isPermitted: () => false,
    currentOrigin: () => null,
    emit: emitPanel,
    results,
    resendState: () => coordinator.resendState(),
    clock,
    timers,
    diagnostics,
  });
  coordinator = createCoordinator({ config: {}, clock, timers, diagnostics, emitPanel, panel: channel, sinks, results });
  channel.start();
  return { coordinator, channel, sinks, app, events };
}

describe("the core's panel sinks", () => {
  it("a new connection becomes a relay sink and is repainted: grant, capabilities, audit, state, after its capture_policy", () => {
    const w = wiring();
    expect(w.app.frames.map((f) => f.type)).toEqual(["state", "grant", "capabilities", "audit"]);
    w.app.frames.length = 0;
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    expect(c.sent[0]).toEqual({ type: "capture_policy", revision: 0, paused: false, captureEnabled: false });
    expect(c.panel().map((f) => f.type)).toEqual(["grant", "capabilities", "audit", "state"]);
    expect(c.panel().at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: 0, permitted: false });
    // The app hears the new state and the shared capabilities refresh, never the repaint's grant/audit.
    expect(w.app.frames.map((f) => f.type)).toEqual(["state", "capabilities"]);
    const caps = (frames: PanelState[]) => frames.filter((f) => f.type === "capabilities").map((f) => (f as { revision: number }).revision);
    expect(caps(c.panel())).toEqual(caps(w.app.frames));
  });

  it("every later frame reaches both sinks; pause and resume are accepted from the relay", () => {
    const w = wiring();
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    const before = c.panel().length;
    w.app.frames.length = 0;
    c.command({ type: "pause" });
    expect(w.app.frames).toEqual([{ type: "state", status: "paused" }]);
    expect(c.panel().slice(before)).toEqual([{ type: "state", status: "paused" }]);
    expect(c.sent.filter((f) => f.type === "capture_policy").at(-1)).toMatchObject({ paused: true });
    c.command({ type: "resume" });
    expect(w.app.frames.at(-1)).toMatchObject({ type: "state", status: "idle" });
    expect(c.panel().at(-1)).toMatchObject({ type: "state", status: "idle" });
  });

  it("acks go only to the sink that sent the command", async () => {
    const w = wiring();
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    const before = c.panel().length;
    w.app.frames.length = 0;
    c.command({ type: "refresh_capabilities", commandId: "side-1" });
    await Promise.resolve();
    w.coordinator.handleNativeCommand({ type: "refresh_capabilities", commandId: "app-1" }, w.app.sink);
    c.command({ type: "open_link", commandId: "side-2", coreInstanceId: "core-test", visitEpoch: 0, jobId: "job-1", candidateId: "c1" });
    await new Promise((r) => setImmediate(r));
    const acks = (frames: PanelState[]) => frames.filter((f) => f.type === "ack");
    expect(acks(c.panel().slice(before))).toEqual([
      { type: "ack", commandId: "side-1", ok: true, revision: 0, approvalRevision: 0 },
      { type: "ack", commandId: "side-2", ok: false, code: "stale_revision" },
    ]);
    expect(acks(w.app.frames)).toEqual([{ type: "ack", commandId: "app-1", ok: true, revision: 0, approvalRevision: 0 }]);
    // Both refreshes reach both surfaces.
    expect(w.app.frames.filter((f) => f.type === "capabilities")).toHaveLength(2);
    expect(c.panel().slice(before).filter((f) => f.type === "capabilities")).toHaveLength(2);
  });

  it("frontmost and shutdown from the relay are never applied; a commandId gets not_permitted on the relay only", () => {
    const w = wiring();
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    const before = c.panel().length;
    w.app.frames.length = 0;
    c.frame({ type: "refused_command", command: "shutdown", commandId: "side-9" });
    c.frame({ type: "refused_command", command: "frontmost" });
    // Even a parsed one handed in directly with the relay sink is refused.
    const sink = { id: "relay-x", kind: "relay" as const, send: () => {} };
    w.coordinator.handleNativeCommand({ type: "shutdown" }, sink);
    w.coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: 1 }, sink);
    expect(w.coordinator.stopped).toBe(false);
    expect(c.panel().slice(before)).toEqual([{ type: "ack", commandId: "side-9", ok: false, code: "not_permitted" }]);
    expect(w.app.frames).toEqual([]);
    expect(w.events.filter((e) => e.name === "native_command_refused").map((e) => e.fields)).toEqual([
      { type: "shutdown", sink: "relay", acked: true },
      { type: "frontmost", sink: "relay" },
      { type: "shutdown", sink: "relay" },
      { type: "frontmost", sink: "relay" },
    ]);
    // The app may still send them.
    w.coordinator.handleNativeCommand({ type: "shutdown" }, w.app.sink);
    expect(w.coordinator.stopped).toBe(true);
  });

  it("a replacing connection takes over the relay sink and is repainted; the old one hears nothing more", () => {
    const w = wiring();
    const a = fakeClient(1);
    w.coordinator.attachClient(a.client);
    a.command({ type: "pause" });
    const aBefore = a.sent.length;
    const b = fakeClient(2);
    w.coordinator.attachClient(b.client);
    expect(b.panel().map((f) => f.type)).toEqual(["grant", "capabilities", "audit", "state"]);
    expect(b.panel().at(-1)).toEqual({ type: "state", status: "paused" });
    expect(w.sinks.list().map((s) => s.id)).toEqual(["stdio", "relay-2"]);
    // A command from the replaced connection is ignored.
    a.command({ type: "resume" });
    expect(w.events.some((e) => e.name === "stale_sensor_frame")).toBe(true);
    b.command({ type: "resume" });
    expect(a.sent.length).toBe(aBefore);
    // A close of the old connection after the replacement does not remove the new sink.
    a.disconnect();
    expect(w.sinks.list().map((s) => s.id)).toEqual(["stdio", "relay-2"]);
    b.disconnect();
    expect(w.sinks.list().map((s) => s.id)).toEqual(["stdio"]);
    expect(w.app.frames.at(-1)).toEqual({ type: "state", status: "disconnected" });
  });
});
