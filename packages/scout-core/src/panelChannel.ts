// Scout's window side of the core: wires the capability view (panelCapabilities.ts), previews
// (previewStream.ts), mutation commands (nativeCommands.ts), the context-read audit, and the
// browser-context grant to the JSONL frames the native app reads. Wiring only; each part's
// rules are in its own file.
//
// On start it sends `grant`, `capabilities`, and `audit` once. Afterwards `capabilities` goes
// out (debounced) whenever `capabilitiesChanged()` is called (the coordinator calls it on
// permission, visit, and ingest changes; commands call it after their ack), `audit` (debounced
// AUDIT_DEBOUNCE_MS, skipped when unchanged) on `auditChanged()`, and `grant` when the user
// toggles it. A `preview` command answers with a chunk, or with a failure ack.
//
// Recommendation results (results.ts): a publish goes out as a `results` frame (hrefs
// stripped); a non-silent clear that dropped a result asks the coordinator to send its current
// state again (`resendState`), which the window reads as "this visit's results are gone". The
// coordinator's own clears are silent: the state frame it sends next resets the window anyway.
// No stand-in `empty` frame is ever sent. `open_link` is answered from the same registry.
//
// A new browser surface (panelSinks.ts: the relay sink of a new native-host connection) is
// repainted by `repaint(sink, state)` through the same path `start()` takes: `grant`, a fresh
// `capabilities` (sent to every sink, a refresh, so one revision sequence serves them all),
// `audit`, then the coordinator's current state and the held `results` frame, if any. All but
// `capabilities` go to that sink only.
//
// Ordering: the window drops a visit's results on any `state` frame for that visit other than
// `working` for the same job. So the coordinator (or P3.2's job scheduler) emits a job's
// `working{jobId}` and then the visit's `idle` before the result is published; an `idle` or
// `resendState` for the same visit after the publish wipes the window's results.

import type { PanelAck, PanelAudit, PanelCommand, PanelState } from "@scout/contracts";
import type { GrantWrite } from "./agentApi/grants.js";
import type { ReadAuditEntry } from "./agentApi/readAudit.js";
import type { StoreState } from "./capabilities/decisions.js";
import type { ExportConflict } from "./capabilities/exports.js";
import type { Clock, Timers } from "./clock.js";
import { createDebounced } from "./debounced.js";
import type { Diagnostics } from "./diagnostics.js";
import { type CommandStore, createNativeCommands } from "./nativeCommands.js";
import { createCapabilitiesEmitter } from "./panelCapabilities.js";
import { createPreviewStream, type PreviewStore } from "./previewStream.js";
import type { PanelSink } from "./panelSinks.js";
import { type ResultRegistry, toFrame } from "./results.js";

export const AUDIT_DEBOUNCE_MS = 250;

export type PanelStore = CommandStore & PreviewStore & { snapshot(): StoreState };

export interface PanelChannelOptions {
  store: PanelStore;
  /** This core start's id (the one agent.sock replies carry); stamped on every `capabilities` frame. */
  coreInstanceId: string;
  /** The exporter's last recorded conflicts; empty when there is no exporter. */
  exportConflicts: () => readonly ExportConflict[];
  readBrowserContextGrant: () => boolean;
  writeBrowserContextGrant: (enabled: boolean) => GrantWrite;
  getAudit: () => readonly ReadAuditEntry[];
  isPermitted: (origin: string) => boolean;
  currentOrigin: () => string | null;
  emit: (frame: PanelState) => void;
  /** Recommendation results; without it `open_link` acks `unavailable`. `current` feeds a repaint. */
  results?: Pick<ResultRegistry, "resolveLink" | "subscribe"> & Partial<Pick<ResultRegistry, "current">>;
  /** Send the coordinator's current state again, even if unchanged (a cleared result). */
  resendState?: () => void;
  clock: Clock;
  timers?: Timers;
  diagnostics: Diagnostics;
}

export interface PanelChannel {
  /** Send the initial grant, capabilities, and audit frames. */
  start(): void;
  /**
   * Bring a newly attached sink up to date: grant, capabilities (to every sink), audit, `state`
   * (the coordinator's current one), and the held results frame, if any.
   */
  repaint(sink: PanelSink, state: PanelState): void;
  /** Run one command from the app; never rejects. */
  handle(cmd: PanelCommand): Promise<void>;
  capabilitiesChanged(): void;
  auditChanged(): void;
  /** Release the pins of abandoned previews. */
  sweepExpired(): void;
  /** Stop sending frames and release every preview pin. Idempotent. */
  stop(): void;
}

export function createPanelChannel(options: PanelChannelOptions): PanelChannel {
  const { store, diagnostics } = options;
  let stopped = false;
  const emit = (frame: PanelState): void => {
    if (stopped) return;
    try {
      options.emit(frame);
    } catch {
      diagnostics.event("panel_emit_failed", {});
    }
  };

  const capabilities = createCapabilitiesEmitter({
    input: () => {
      let conflicts: readonly ExportConflict[] = [];
      try {
        conflicts = options.exportConflicts();
      } catch {
        // An unreadable manifest shows no conflicts; the exporter reports it.
      }
      return { state: store.snapshot(), conflicts, isPermitted: options.isPermitted, currentOrigin: options.currentOrigin() };
    },
    coreInstanceId: options.coreInstanceId,
    emit,
    diagnostics,
    ...(options.timers ? { timers: options.timers } : {}),
  });

  let lastAudit: string | null = null;
  const auditFrame = (): PanelAudit => ({
    type: "audit",
    entries: options.getAudit().map((e) => ({ at: e.at, role: e.role, method: e.method, outcome: e.outcome, ...(e.origin !== undefined ? { origin: e.origin } : {}) })),
  });
  const sendAudit = (): void => {
    const frame = auditFrame();
    const key = JSON.stringify(frame.entries);
    if (key === lastAudit) return;
    lastAudit = key;
    emit(frame);
  };
  const grantFrame = (): PanelState => ({ type: "grant", agentBrowserContext: options.readBrowserContextGrant() });

  /** The start/restart paint: grant, capabilities (always to every sink), audit. */
  const paint = (send: (frame: PanelState) => void, sendAuditFrame: () => void): void => {
    send(grantFrame());
    capabilities.refresh();
    sendAuditFrame();
  };
  const audit = createDebounced(sendAudit, AUDIT_DEBOUNCE_MS, options.timers);

  const previews = createPreviewStream({ store, clock: options.clock });
  const commands = createNativeCommands({
    store,
    isPermitted: options.isPermitted,
    writeBrowserContextGrant: options.writeBrowserContextGrant,
    readBrowserContextGrant: options.readBrowserContextGrant,
    emitAck: emit,
    onStoreChanged: () => capabilities.changed(),
    onGrantChanged: (enabled) => emit({ type: "grant", agentBrowserContext: enabled }),
    refreshCapabilities: () => capabilities.refresh(),
    ...(options.results ? { results: options.results } : {}),
    diagnostics,
  });

  const unsubscribeResults = options.results?.subscribe((event) => {
    if (event.kind === "published") emit(event.frame);
    else if (!stopped) options.resendState?.();
  });

  return {
    start() {
      paint(emit, () => audit.flush());
    },
    repaint(sink, state) {
      if (stopped) return;
      const send = (frame: PanelState): void => {
        try {
          sink.send(frame);
        } catch {
          diagnostics.event("panel_emit_failed", { sink: sink.kind });
        }
      };
      paint(send, () => send(auditFrame()));
      send(state);
      const held = options.results?.current?.();
      if (held) send(toFrame(held));
      diagnostics.event("panel_repainted", { sink: sink.kind, results: held ? 1 : 0 });
    },
    async handle(cmd) {
      if (stopped) return;
      if (cmd.type !== "preview") return commands.handle(cmd);
      const answer = previews.serve(cmd);
      if (answer.ok) {
        diagnostics.event("preview_chunk", { bytes: Buffer.byteLength(answer.chunk.text, "utf8"), seq: answer.chunk.seq });
        emit(answer.chunk);
        return;
      }
      const ack: PanelAck = { type: "ack", commandId: cmd.commandId, ok: false, code: answer.code, ...(answer.revision !== undefined ? { revision: answer.revision } : {}) };
      diagnostics.event("native_command", { type: "preview", ok: false, code: answer.code });
      emit(ack);
    },
    capabilitiesChanged: () => capabilities.changed(),
    auditChanged: () => {
      if (!stopped) audit.schedule();
    },
    sweepExpired: () => previews.sweepExpired(),
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeResults?.();
      capabilities.stop();
      audit.cancel();
      previews.close();
    },
  };
}
