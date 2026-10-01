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

import type { PanelAck, PanelCommand, PanelState } from "@scout/contracts";
import type { ReadAuditEntry } from "./agentApi/readAudit.js";
import type { StoreState } from "./capabilities/decisions.js";
import type { ExportConflict } from "./capabilities/exports.js";
import type { Clock, Timers } from "./clock.js";
import { createDebounced } from "./debounced.js";
import type { Diagnostics } from "./diagnostics.js";
import { type CommandStore, createNativeCommands } from "./nativeCommands.js";
import { createCapabilitiesEmitter } from "./panelCapabilities.js";
import { createPreviewStream, type PreviewStore } from "./previewStream.js";

export const AUDIT_DEBOUNCE_MS = 250;

export type PanelStore = CommandStore & PreviewStore & { snapshot(): StoreState };

export interface PanelChannelOptions {
  store: PanelStore;
  /** This core start's id (the one agent.sock replies carry); stamped on every `capabilities` frame. */
  coreInstanceId: string;
  /** The exporter's last recorded conflicts; empty when there is no exporter. */
  exportConflicts: () => readonly ExportConflict[];
  readBrowserContextGrant: () => boolean;
  writeBrowserContextGrant: (enabled: boolean) => void;
  getAudit: () => readonly ReadAuditEntry[];
  isPermitted: (origin: string) => boolean;
  currentOrigin: () => string | null;
  emit: (frame: PanelState) => void;
  clock: Clock;
  timers?: Timers;
  diagnostics: Diagnostics;
}

export interface PanelChannel {
  /** Send the initial grant, capabilities, and audit frames. */
  start(): void;
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
  const sendAudit = (): void => {
    const entries = options.getAudit().map((e) => ({ at: e.at, role: e.role, method: e.method, outcome: e.outcome, ...(e.origin !== undefined ? { origin: e.origin } : {}) }));
    const key = JSON.stringify(entries);
    if (key === lastAudit) return;
    lastAudit = key;
    emit({ type: "audit", entries });
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
    diagnostics,
  });

  return {
    start() {
      emit({ type: "grant", agentBrowserContext: options.readBrowserContextGrant() });
      capabilities.refresh();
      audit.flush();
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
      capabilities.stop();
      audit.cancel();
      previews.close();
    },
  };
}
