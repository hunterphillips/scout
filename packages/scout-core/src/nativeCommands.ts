// Executes the mutation commands Scout's window sends (approve, decline, revoke, auto-acquire,
// the browser-context grant, refresh) and answers each with exactly one ack.
//
// Order: a success ack goes out only after the change is persisted (the store's write, or the
// config.json rename), and before the export sync it may start has finished (the store's
// `cleanup`; its outcome reaches the app as a later `capabilities` frame). Failures are acks
// with a closed code set: `stale_revision`, `not_found`, `invalid`, `not_permitted`,
// `unavailable` (store closed), `store_error`.
//
// Idempotency: the last COMMAND_CACHE_SIZE command IDs are remembered with the command they
// named. A retried ID gets the first attempt's ack again without touching the store (a retry
// that arrives while the first attempt is still running waits for it). A failed attempt is
// forgotten once it settles, so a retry after a failure runs again; the same ID reused for a
// different command is `invalid`. The cache is in memory: after a core restart the store's
// own checks apply (re-approving the current default and re-declining are no-ops; a stale
// revision is refused).
//
// Revision checks:
// - approve/decline: `expectedRevision` is the resource's revision; the store checks it inside
//   its write queue (StaleApprovalError -> `stale_revision`). Approving a pending version also
//   requires its site origin to be Chrome-permitted now (`not_permitted`): an offer the user
//   could no longer see is not accepted. Re-approving a revoked resource's version has no such
//   check; that is the library's explicit re-approval.
// - revoke: checked here against the in-memory revision just before the store call; a
//   resource that is already blocked acks `ok` whatever the revision (the store re-runs its
//   revocation hooks and export cleanup). Revocation is not content-specific, so a version
//   recorded between the check and the queued write is revoked too.
// - set_auto_acquire: origin policies carry no revision, so there is no stale check. Turning it
//   on needs `acknowledgeRisk: true` (`invalid` otherwise) and the origin Chrome-permitted now
//   (`not_permitted`); turning it off always applies.
// Acks for commands not about one resource carry `revision: 0`.

import type { MutationCommand, PanelAck } from "@scout/contracts";
import { DecisionError, StaleApprovalError } from "./capabilities/decisions.js";
import { type CapabilityStore, type ExportSync, StoreReadOnlyError } from "./capabilities/store.js";
import type { Diagnostics } from "./diagnostics.js";

export const COMMAND_CACHE_SIZE = 256;

export type CommandStore = Pick<CapabilityStore, "getResource" | "approve" | "decline" | "revoke" | "setOriginPolicy" | "approvalRevision">;

export interface NativeCommandsOptions {
  store: CommandStore;
  isPermitted: (origin: string) => boolean;
  /** Persist the browser-context grant; throws when it could not. */
  writeBrowserContextGrant: (enabled: boolean) => void;
  emitAck: (ack: PanelAck) => void;
  /** Stored state changed: the capabilities view may differ. */
  onStoreChanged: () => void;
  /** The browser-context grant was written. */
  onGrantChanged: (enabled: boolean) => void;
  /** `refresh_capabilities`: send the capabilities view now. */
  refreshCapabilities: () => void;
  diagnostics?: Diagnostics;
  cacheSize?: number;
}

export interface NativeCommands {
  /** Run `cmd` and emit its ack. Never rejects. */
  handle(cmd: MutationCommand): Promise<void>;
}

type Outcome = { ack: PanelAck; cleanup?: ExportSync };

export function createNativeCommands(options: NativeCommandsOptions): NativeCommands {
  const { store, diagnostics } = options;
  const cacheSize = options.cacheSize ?? COMMAND_CACHE_SIZE;
  const cache = new Map<string, { fingerprint: string; result: Promise<PanelAck> }>();

  const ok = (commandId: string, revision: number, approvalRevision: number = store.approvalRevision): PanelAck => ({
    type: "ack",
    commandId,
    ok: true,
    revision,
    approvalRevision,
  });
  const failed = (commandId: string, code: Extract<PanelAck, { ok: false }>["code"], revision?: number): PanelAck =>
    revision === undefined ? { type: "ack", commandId, ok: false, code } : { type: "ack", commandId, ok: false, code, revision };
  const currentRevision = (resourceId: string): number | undefined => store.getResource(resourceId)?.revision;

  /** The ack for a store call that threw. */
  function fromError(commandId: string, error: unknown, resourceId?: string): PanelAck {
    const revision = resourceId === undefined ? undefined : currentRevision(resourceId);
    if (error instanceof StaleApprovalError) return failed(commandId, "stale_revision", revision);
    if (error instanceof DecisionError) return failed(commandId, error.code === "not_found" ? "not_found" : "invalid", revision);
    if (error instanceof StoreReadOnlyError) return failed(commandId, "unavailable", revision);
    return failed(commandId, "store_error", revision);
  }

  async function run(cmd: MutationCommand): Promise<Outcome> {
    const id = cmd.commandId;
    switch (cmd.type) {
      case "approve":
      case "decline": {
        const r = store.getResource(cmd.resourceId);
        if (!r) return { ack: failed(id, "not_found") };
        const v = r.resource.versions.find((x) => x.hash === cmd.version);
        if (cmd.type === "approve" && v?.state === "pending" && !options.isPermitted(r.resource.siteOrigin)) {
          return { ack: failed(id, "not_permitted", r.revision) };
        }
        const decision = { resourceId: cmd.resourceId, version: cmd.version, expectedRevision: cmd.expectedRevision };
        try {
          if (cmd.type === "approve") {
            const result = await store.approve(decision);
            return { ack: ok(id, result.revision, result.approvalRevision), cleanup: result.cleanup };
          }
          const result = await store.decline(decision);
          return { ack: ok(id, result.revision, result.approvalRevision) };
        } catch (error) {
          return { ack: fromError(id, error, cmd.resourceId) };
        }
      }
      case "revoke": {
        const r = store.getResource(cmd.resourceId);
        if (!r) return { ack: failed(id, "not_found") };
        if (!r.resource.blocked && r.revision !== cmd.expectedRevision) return { ack: failed(id, "stale_revision", r.revision) };
        try {
          const result = await store.revoke(cmd.resourceId);
          return { ack: ok(id, result.revision, result.approvalRevision), cleanup: result.cleanup };
        } catch (error) {
          return { ack: fromError(id, error, cmd.resourceId) };
        }
      }
      case "set_auto_acquire": {
        if (cmd.enabled && !cmd.acknowledgeRisk) return { ack: failed(id, "invalid") };
        if (cmd.enabled && !options.isPermitted(cmd.origin)) return { ack: failed(id, "not_permitted") };
        try {
          const result = await store.setOriginPolicy({ origin: cmd.origin, autoAcquire: cmd.enabled, acknowledgeRisk: cmd.acknowledgeRisk });
          return { ack: ok(id, 0, result.approvalRevision) };
        } catch (error) {
          return { ack: fromError(id, error) };
        }
      }
      case "set_agent_browser_context":
        try {
          options.writeBrowserContextGrant(cmd.enabled);
        } catch {
          return { ack: failed(id, "store_error") };
        }
        options.onGrantChanged(cmd.enabled);
        return { ack: ok(id, 0) };
      case "refresh_capabilities":
        options.refreshCapabilities();
        return { ack: ok(id, 0) };
    }
  }

  const emit = (ack: PanelAck, type: string): void => {
    diagnostics?.event("native_command", { type, ok: ack.ok, ...(ack.ok ? {} : { code: ack.code }) });
    options.emitAck(ack);
  };

  return {
    async handle(cmd) {
      const { commandId, ...rest } = cmd;
      const fingerprint = JSON.stringify(rest);
      const seen = cache.get(commandId);
      if (seen) {
        if (seen.fingerprint !== fingerprint) {
          emit(failed(commandId, "invalid"), cmd.type);
          return;
        }
        emit(await seen.result, cmd.type);
        return;
      }
      const running = run(cmd).catch((): Outcome => ({ ack: failed(commandId, "store_error") }));
      const attempt = running.then((o) => o.ack);
      cache.set(commandId, { fingerprint, result: attempt });
      while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
      const { ack, cleanup } = await running;
      if (!ack.ok && cache.get(commandId)?.result === attempt) cache.delete(commandId);
      emit(ack, cmd.type);
      // The changed view follows the ack; the export outcome (conflicts) follows the sync.
      if (ack.ok && cmd.type !== "set_agent_browser_context" && cmd.type !== "refresh_capabilities") {
        options.onStoreChanged();
        void cleanup?.then(options.onStoreChanged);
      }
    },
  };
}
