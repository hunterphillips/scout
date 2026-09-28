import type { PageTextObservation } from "@scout/contracts";
import type { Diagnostics } from "./diagnostics.js";

/**
 * Sends one observation to the personal-context service's `observe_activity`. Resolves
 * when the service acknowledges it; rejects when the send fails. Phase 3 wires the real
 * client; Phase 1 uses the default, which only logs counts.
 */
export type ActivitySend = (obs: PageTextObservation) => Promise<void>;

export interface ActivityForwarderOptions {
  diagnostics: Diagnostics;
  send?: ActivitySend;
}

export interface ActivityForwarder {
  /**
   * Bumps `contextRevision` synchronously, then sends. The returned promise settles when
   * the send is acknowledged or fails; it never rejects.
   */
  forward(obs: PageTextObservation): Promise<void>;
  /** Scout's current contextRevision; feeds the visit tracker's getContextRevision. */
  readonly contextRevision: number;
  /** Sends not yet acknowledged or failed. */
  readonly pendingCount: number;
}

const utf8 = new TextEncoder();

export function createActivityForwarder(options: ActivityForwarderOptions): ActivityForwarder {
  const { diagnostics } = options;
  // Phase 1 default: record that something was forwarded, never what.
  const send: ActivitySend =
    options.send ??
    (async (obs) => {
      diagnostics.event("activity_forwarded", { bytes: utf8.encode(obs.text).byteLength, truncated: obs.truncated });
    });
  let contextRevision = 0;
  let pending = 0;

  return {
    get contextRevision() {
      return contextRevision;
    },
    get pendingCount() {
      return pending;
    },
    async forward(obs) {
      contextRevision += 1;
      pending += 1;
      const revision = contextRevision;
      try {
        await send(obs);
        diagnostics.event("activity_acked", { contextRevision: revision });
      } catch {
        diagnostics.event("activity_failed", { contextRevision: revision });
      } finally {
        pending -= 1;
      }
    },
  };
}
