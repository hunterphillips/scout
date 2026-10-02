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
  const drainHandlers: Array<() => void> = [];
  const sent: ToChromeFrame[] = [];
  const client: SocketClient = {
    id,
    send: (f) => void sent.push(f),
    onFrame: (h) => void handlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    onDrained: (h) => void drainHandlers.push(h),
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
    drained: () => {
      for (const h of drainHandlers) h();
    },
  };
}

const SITE = "https://docs.example.com";

function wiring(opts: { routeLimit?: number; visit?: boolean } = {}) {
  const { diagnostics, events } = spy();
  const clock = { now: () => 1_000 };
  const sinks = createPanelSinks({ diagnostics, ...(opts.routeLimit !== undefined ? { routeLimit: opts.routeLimit } : {}) });
  const app = recordingSink("stdio", "stdio");
  sinks.add(app.sink);
  const emitPanel = (f: PanelState): void => sinks.emit(f);
  const pending: Array<() => void> = [];
  const timers = { setTimeout: (fn: () => void) => (pending.push(fn), pending.length), clearTimeout: () => {} };
  let coordinator: ReturnType<typeof createCoordinator>;
  const results = createResultRegistry({
    coreInstanceId: "core-test",
    activeVisit: () => (opts.visit ? { visitEpoch: 2, origin: SITE } : null),
    isPermitted: () => opts.visit === true,
    diagnostics,
  });
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
    deliver: (sink, frame) => sinks.deliver(sink, frame),
    clock,
    timers,
    diagnostics,
  });
  coordinator = createCoordinator({ config: {}, clock, timers, diagnostics, emitPanel, panel: channel, sinks, results });
  channel.start();
  /** Hold an ok result for visit 2 whose one link is SITE/webhooks. */
  const publish = (): void => {
    results.beginJob("job-1");
    const r = results.publish({
      coreInstanceId: "core-test",
      visitEpoch: 2,
      origin: SITE,
      jobId: "job-1",
      status: "ok",
      items: [{ candidateId: "c1", title: "Webhooks", reason: "r", href: `${SITE}/webhooks`, hostname: "docs.example.com" }],
    });
    expect(r.ok).toBe(true);
  };
  return { coordinator, channel, sinks, app, events, results, publish };
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

  const openLink = (commandId: string) => ({ type: "open_link" as const, commandId, coreInstanceId: "core-test", visitEpoch: 2, jobId: "job-1", candidateId: "c1" });
  const settle = () => new Promise((r) => setImmediate(r));

  it("a relay commandId that collides with a live stdio one is refused invalid on the relay alone, and no open_link target crosses", async () => {
    const w = wiring({ visit: true });
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    w.publish();
    w.coordinator.handleNativeCommand(openLink("x"), w.app.sink);
    await settle();
    expect(w.app.frames.filter((f) => f.type === "ack")).toEqual([
      { type: "ack", commandId: "x", ok: true, revision: 0, approvalRevision: 0, target: { href: `${SITE}/webhooks` } },
    ]);
    const before = c.panel().length;
    c.command(openLink("x"));
    await settle();
    expect(c.panel().slice(before)).toEqual([{ type: "ack", commandId: "x", ok: false, code: "invalid" }]);
    expect(JSON.stringify(c.sent)).not.toContain("/webhooks");
    expect(w.app.frames.filter((f) => f.type === "ack")).toHaveLength(1);
    expect(w.events.filter((e) => e.name === "command_id_collision")).toEqual([{ name: "command_id_collision", fields: { sink: "relay" } }]);
  });

  it("once the stdio route is gone, the relay's reuse of the id runs on its own, never answered from the app's idempotency entry", async () => {
    const w = wiring({ visit: true, routeLimit: 1 });
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    w.publish();
    w.coordinator.handleNativeCommand(openLink("x"), w.app.sink);
    await settle();
    w.coordinator.handleNativeCommand({ type: "refresh_capabilities", commandId: "y" }, w.app.sink); // evicts x's route
    await settle();
    w.results.clear("visit_changed", { silent: true }); // a fresh resolve now fails
    const before = c.panel().length;
    c.command(openLink("x"));
    await settle();
    expect(c.panel().slice(before).filter((f) => f.type === "ack")).toEqual([{ type: "ack", commandId: "x", ok: false, code: "stale_revision" }]);
    expect(JSON.stringify(c.sent)).not.toContain("/webhooks");
  });

  it("a command with a commandId from a replaced connection is answered unavailable on it alone; a bare one only logged", () => {
    const w = wiring();
    const a = fakeClient(1);
    w.coordinator.attachClient(a.client);
    const b = fakeClient(2);
    w.coordinator.attachClient(b.client);
    const aBefore = a.sent.length;
    const bBefore = b.sent.length;
    w.app.frames.length = 0;
    a.command({ type: "pause" });
    a.command({ type: "refresh_capabilities", commandId: "old-1" });
    expect(a.sent.slice(aBefore)).toEqual([{ type: "panel", state: { type: "ack", commandId: "old-1", ok: false, code: "unavailable" } }]);
    expect(b.sent.length).toBe(bBefore);
    expect(w.app.frames).toEqual([]);
    expect(w.coordinator.agentView().paused).toBe(false);
    expect(w.events.filter((e) => e.name === "stale_sensor_frame")).toHaveLength(2);
  });

  it("an observation-only protocol-3 client costs nothing beyond the repaint: no routes, no extra frames for the app", () => {
    const w = wiring();
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    const appAfterAttach = w.app.frames.length;
    c.observe({ kind: "permissions", revision: 1, at: 1, granted: ["https://docs.stripe.com/*"], githubCapture: false });
    c.observe({ kind: "focus", seq: 1, at: 1, browserFocused: true, windowId: 1, tabId: 3, url: "https://docs.stripe.com/x", permissionsRevision: 1 });
    // Only the repaint's grant and audit went to it alone; everything else it got, the app got too.
    const sharedTypes = (frames: PanelState[]) => frames.filter((f) => f.type !== "grant" && f.type !== "audit").map((f) => JSON.stringify(f));
    const panelAfterRepaint = c.panel().slice(4);
    expect(c.panel().slice(0, 4).map((f) => f.type)).toEqual(["grant", "capabilities", "audit", "state"]);
    expect(sharedTypes(panelAfterRepaint)).toEqual(sharedTypes(w.app.frames.slice(appAfterAttach)));
    expect(w.sinks.routeOf("anything")).toBeUndefined();
    expect(w.app.frames.some((f) => f.type === "grant" || f.type === "audit")).toBe(true); // only the start's
    expect(w.app.frames.filter((f) => f.type === "grant")).toHaveLength(1);
  });

  it("after backpressure the connection's drain repaints it with the last state (and the held result)", () => {
    const w = wiring({ visit: true });
    const c = fakeClient(1);
    w.coordinator.attachClient(c.client);
    w.publish();
    const before = c.panel().length;
    c.drained();
    expect(c.panel().slice(before).map((f) => f.type)).toEqual(["grant", "capabilities", "audit", "state", "results"]);
    expect(JSON.stringify(c.panel().slice(before))).not.toContain("/webhooks");
    // A replaced connection's drain repaints nothing.
    w.coordinator.attachClient(fakeClient(2).client);
    const after = c.panel().length;
    c.drained();
    expect(c.panel().length).toBe(after);
  });
});

describe("the core's panel sinks over a real socket", () => {
  it("an ack for a connection that closed before it is dropped as panel_ack_dropped sink_gone", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { connect } = await import("node:net");
    const { encodeFrame } = await import("@scout/contracts/frame");
    const { createSocketServer } = await import("./socketServer.js");
    const root = mkdtempSync(join(tmpdir(), "sinks-"));
    const { diagnostics, events } = spy();
    const sinks = createPanelSinks({ diagnostics });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const emitPanel = (f: PanelState): void => sinks.emit(f);
    const coordinator = createCoordinator({
      config: {},
      clock: { now: () => 1_000 },
      diagnostics,
      emitPanel,
      sinks,
      // A command whose answer comes late: after the connection is gone.
      panel: {
        handle: async (cmd) => {
          await gate;
          emitPanel({ type: "ack", commandId: cmd.commandId, ok: true, revision: 0, approvalRevision: 0 });
        },
        capabilitiesChanged: () => {},
      },
    });
    const server = createSocketServer({ runDir: join(root, "run"), onClient: (cl) => coordinator.attachClient(cl), diagnostics });
    await server.start();
    try {
      const sock = connect({ path: server.socketPath });
      sock.on("error", () => {});
      await new Promise((r) => sock.once("connect", r));
      sock.write(encodeFrame({ type: "hello", protocol: 3 }));
      sock.write(encodeFrame({ type: "command", command: { type: "refresh_capabilities", commandId: "late-1" } }));
      const until = async (cond: () => boolean) => {
        const start = Date.now();
        while (!cond()) {
          if (Date.now() - start > 2_000) throw new Error("timed out");
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await until(() => sinks.routeOf("late-1") !== undefined);
      sock.destroy();
      await until(() => events.some((e) => e.name === "bridge_close"));
      expect(sinks.list().map((s) => s.kind)).toEqual([]);
      release();
      await until(() => events.some((e) => e.name === "panel_ack_dropped"));
      expect(events.find((e) => e.name === "panel_ack_dropped")?.fields).toEqual({ type: "ack", reason: "sink_gone" });
    } finally {
      coordinator.stop();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
