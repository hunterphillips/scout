// Where panel frames go. There are two possible sinks: the Mac app (JSONL on the core's stdout,
// the `stdio` sink, registered once at start) and the Chrome side panel (the live native-host
// connection, a `relay` sink, registered when that connection completes its hello and removed
// when it closes or is replaced). The Mac app reads only `state` frames; the side panel reads
// every frame.
//
// Every frame goes to every sink, except the answers to one command: an `ack`, and a `preview`
// chunk, go only to the sink that sent the command with that `commandId` (the last one to send
// it, when two did). The `commandId -> sink` routes are bounded like the commands' idempotency
// cache (COMMAND_CACHE_SIZE), oldest first out. An answer with no route, or whose sink is gone,
// is dropped with a `panel_ack_dropped` event. With no relay sink attached nothing changes for
// the app.

import type { PanelState } from "@scout/contracts";
import type { Diagnostics } from "./diagnostics.js";
import { COMMAND_CACHE_SIZE } from "./nativeCommands.js";

export interface PanelSink {
  /** Unique among the sinks of one core start. */
  readonly id: string;
  readonly kind: "stdio" | "relay";
  /** Deliver one frame; the sink drops it silently once its transport is closed. */
  send(frame: PanelState): void;
}

export interface PanelSinks {
  add(sink: PanelSink): void;
  /** Idempotent. Answers routed to it from now on are dropped. */
  remove(sink: PanelSink): void;
  has(sink: PanelSink): boolean;
  /** Fan a frame out (or route a command's answer to its sender). */
  emit(frame: PanelState): void;
  /** `sink` sent the command `commandId`: its answer goes there. */
  routeCommand(commandId: string, sink: PanelSink): void;
  /** The sink the answer to `commandId` would go to, if it is still attached. */
  routeOf(commandId: string): PanelSink | undefined;
  /** Send one frame to one sink, bypassing fan-out and routes (a repaint, a direct refusal). */
  deliver(sink: PanelSink, frame: PanelState): void;
  /** The attached sinks, in registration order. */
  list(): readonly PanelSink[];
}

export interface PanelSinksOptions {
  diagnostics: Diagnostics;
  /** How many command routes are kept; defaults to COMMAND_CACHE_SIZE. */
  routeLimit?: number;
}

/** The frames that answer one command, by its `commandId`. */
const isAnswer = (frame: PanelState): frame is Extract<PanelState, { type: "ack" | "preview" }> => frame.type === "ack" || frame.type === "preview";

export function createPanelSinks(options: PanelSinksOptions): PanelSinks {
  const { diagnostics } = options;
  const routeLimit = options.routeLimit ?? COMMAND_CACHE_SIZE;
  const sinks: PanelSink[] = [];
  const routes = new Map<string, PanelSink>();

  const deliver = (sink: PanelSink, frame: PanelState): void => {
    try {
      sink.send(frame);
    } catch {
      diagnostics.event("panel_emit_failed", { sink: sink.kind });
    }
  };

  return {
    add(sink) {
      if (!sinks.includes(sink)) sinks.push(sink);
    },
    remove(sink) {
      const i = sinks.indexOf(sink);
      if (i >= 0) sinks.splice(i, 1);
    },
    has: (sink) => sinks.includes(sink),
    deliver,
    routeOf(commandId) {
      const sink = routes.get(commandId);
      return sink !== undefined && sinks.includes(sink) ? sink : undefined;
    },
    list: () => [...sinks],
    routeCommand(commandId, sink) {
      routes.delete(commandId); // a re-sent id moves to the newest end
      routes.set(commandId, sink);
      while (routes.size > routeLimit) routes.delete(routes.keys().next().value!);
    },
    emit(frame) {
      if (!isAnswer(frame)) {
        for (const sink of [...sinks]) deliver(sink, frame);
        return;
      }
      const sink = routes.get(frame.commandId);
      if (sink === undefined || !sinks.includes(sink)) {
        diagnostics.event("panel_ack_dropped", { type: frame.type, reason: sink === undefined ? "no_route" : "sink_gone" });
        return;
      }
      deliver(sink, frame);
    },
  };
}
