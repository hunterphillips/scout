// Executes the mutation commands the side panel sends (approve, decline, revoke, auto-acquire,
// the browser-context grant, a site's recommendations switch, the agent choice, refresh) and
// answers each with exactly one ack.
//
// Order: a success ack goes out only after the change is persisted (the store's write, or the
// config.json rename), and before the export sync it may start has finished (the store's
// `cleanup`; its outcome reaches the panel as a later `capabilities` frame). Failures are acks
// with a closed code set: `stale_revision`, `not_found`, `invalid`, `not_permitted`,
// `unavailable` (store closed), `store_error`.
//
// Idempotency: the last COMMAND_CACHE_SIZE command IDs are remembered with the command they
// named, per sender (`scope`, the panel sink's id): one surface's retry never answers from
// another surface's entry, so an id reused across surfaces never returns the other's ack. A retried ID gets the first attempt's ack again without touching the store (a retry
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
//   check; that is the library's explicit re-approval. A version the resource does not record
//   is `not_found`.
// - revoke: the store checks `expectedRevision` inside its write queue; a resource that is
//   already blocked acks `ok` whatever the revision (the store re-runs its revocation hooks and
//   export cleanup).
// - The two consent toggles are compare-and-set on `expectedEnabled`, the value the user saw;
//   a different current value acks `stale_revision` (no `revision`) and writes nothing, so a
//   delayed or retried toggle (even one the ID cache forgot) never undoes a later one.
//   set_auto_acquire compares with the origin's policy (none = off) inside the store's queue.
//   Turning it on also needs `acknowledgeRisk: true` (`invalid` otherwise) and the origin
//   Chrome-permitted now (`not_permitted`). set_agent_browser_context compares with the grant
//   as the agent API reads it; an enable that the agent API does not read back as on (another
//   invalid key in config.json) puts the previous config.json back and acks `invalid`, so a
//   later repair of that key cannot turn the grant on without the user.
//   set_destination (the side panel's per-site recommendations switch) compares with
//   config.json `destinations` as it is on disk (wiring/destinations.ts); `invalid` when the list
//   is full or the file's `destinations` is malformed, `store_error` when config.json is not a
//   regular file the user owns or the write failed, `unavailable` without a writer.
//   Toggles carry no revision, so a boolean compare cannot tell a retried enable from a new one
//   after an intervening disable (enable, disable, retried enable). Within one core the ID cache
//   answers the retry; the app never retries a toggle across a core restart.
// - set_agent (Settings' agent choice) is a set, not a toggle: it carries no compare, and naming
//   the adapter the profile already names acks `ok` and writes nothing, so a retry or a delayed
//   duplicate never changes more than the user asked. The writer (wiring/jobs.ts switchAgent)
//   acks `invalid` for an unknown adapter, `not_found` when its executable is not found,
//   `store_error` when the write fails, and `unavailable` without the profile lock; without a
//   writer the command acks `unavailable`. The capabilities frame that follows the ack shows the
//   new choice.
// - open_link (a click on a recommended link): the result registry (results.ts) checks the
//   displayed identity against the result it holds and re-checks the stored target and the
//   origin's grant; `ok` carries `target: { href }` (only this command's ack does). Codes:
//   `stale_revision`, `not_found`, `not_permitted`, `unavailable` (also without a registry).
//   It changes no stored state. A retried ID gets the first ok ack (and target) again from the
//   cache, without resolving again, even if the result has since been cleared: the duplicate
//   carries the href resolved for the original click. The app opens a link only for the ack
//   that settles a pending `open_link` it issued, so a duplicate ack opens nothing more.
// Acks for commands not about one resource carry `revision: 0`.

import type { MutationCommand, PanelAck } from "@scout/contracts";
import type { GrantWrite } from "./agentApi/grants.js";
import { DecisionError, StaleApprovalError } from "./capabilities/decisions.js";
import { type CapabilityStore, type ExportSync, StoreReadOnlyError } from "./capabilities/store.js";
import type { Diagnostics } from "./diagnostics.js";
import type { ResultRegistry } from "./results.js";
import type { SwitchAgentOutcome } from "./agents/profileSwitch.js";
import type { SetDestinationOutcome } from "./wiring/destinations.js";

export const COMMAND_CACHE_SIZE = 256;

export type CommandStore = Pick<CapabilityStore, "getResource" | "originPolicy" | "approve" | "decline" | "revoke" | "setOriginPolicy" | "approvalRevision">;

export interface NativeCommandsOptions {
  store: CommandStore;
  isPermitted: (origin: string) => boolean;
  /** Persist the browser-context grant; throws when it could not. The result undoes the write. */
  writeBrowserContextGrant: (enabled: boolean) => GrantWrite;
  /** The grant as the agent API reads it from disk (readBrowserContextGrant). */
  readBrowserContextGrant: () => boolean;
  emitAck: (ack: PanelAck) => void;
  /** Stored state changed: the capabilities view may differ. */
  onStoreChanged: () => void;
  /** The browser-context grant was written; `enabled` is what the agent API now reads. */
  onGrantChanged: (enabled: boolean) => void;
  /**
   * `set_destination`: write and apply one host's recommendations switch (compare-and-set on
   * `expectedEnabled`); its `grant` frame goes out from the caller. Without it the command acks
   * `unavailable`.
   */
  setDestination?: (origin: string, enabled: boolean, expectedEnabled: boolean) => SetDestinationOutcome;
  /** `set_agent`: write the profile for that adapter (wiring/jobs.ts `switchAgent`). Without it the command acks `unavailable`. */
  setAgent?: (agent: string) => SwitchAgentOutcome;
  /** `refresh_capabilities`: send the capabilities view now. */
  refreshCapabilities: () => void;
  /** Resolves `open_link`; without it every `open_link` acks `unavailable`. */
  results?: Pick<ResultRegistry, "resolveLink">;
  diagnostics?: Diagnostics;
  cacheSize?: number;
}

export interface NativeCommands {
  /** Run `cmd` and emit its ack. Never rejects. `scope` names the sender (default: one shared scope). */
  handle(cmd: MutationCommand, scope?: string): Promise<void>;
}

type Outcome = { ack: PanelAck; cleanup?: ExportSync };

export function createNativeCommands(options: NativeCommandsOptions): NativeCommands {
  const { store, diagnostics } = options;
  const cacheSize = options.cacheSize ?? COMMAND_CACHE_SIZE;
  const cache = new Map<string, { fingerprint: string; result: Promise<PanelAck> }>();

  const ok = (commandId: string, revision: number, approvalRevision: number = store.approvalRevision): Extract<PanelAck, { ok: true }> => ({
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
        if (!v) return { ack: failed(id, "not_found", r.revision) };
        if (cmd.type === "approve" && v.state === "pending" && !options.isPermitted(r.resource.siteOrigin)) {
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
        try {
          const result = await store.revoke(cmd.resourceId, cmd.expectedRevision);
          return { ack: ok(id, result.revision, result.approvalRevision), cleanup: result.cleanup };
        } catch (error) {
          return { ack: fromError(id, error, cmd.resourceId) };
        }
      }
      case "set_auto_acquire": {
        if ((store.originPolicy(cmd.origin)?.autoAcquire ?? false) !== cmd.expectedEnabled) return { ack: failed(id, "stale_revision") };
        if (cmd.enabled && !cmd.acknowledgeRisk) return { ack: failed(id, "invalid") };
        if (cmd.enabled && !options.isPermitted(cmd.origin)) return { ack: failed(id, "not_permitted") };
        try {
          const result = await store.setOriginPolicy({
            origin: cmd.origin,
            autoAcquire: cmd.enabled,
            acknowledgeRisk: cmd.acknowledgeRisk,
            expectedAutoAcquire: cmd.expectedEnabled,
          });
          return { ack: ok(id, 0, result.approvalRevision) };
        } catch (error) {
          return { ack: fromError(id, error) };
        }
      }
      case "set_agent_browser_context": {
        // Read and write are synchronous, so no other command runs between the compare and the set.
        if (options.readBrowserContextGrant() !== cmd.expectedEnabled) return { ack: failed(id, "stale_revision") };
        let written: GrantWrite;
        try {
          written = options.writeBrowserContextGrant(cmd.enabled);
        } catch {
          return { ack: failed(id, "store_error") };
        }
        // Another invalid key in config.json makes the whole file count as not granted. Leaving
        // the write in place would let a later repair of that key grant access unasked.
        if (options.readBrowserContextGrant() !== cmd.enabled) {
          try {
            written.restore();
          } catch {
            return { ack: failed(id, "store_error") };
          }
          options.onGrantChanged(options.readBrowserContextGrant());
          return { ack: failed(id, "invalid") };
        }
        options.onGrantChanged(cmd.enabled);
        return { ack: ok(id, 0) };
      }
      case "set_destination": {
        if (!options.setDestination) return { ack: failed(id, "unavailable") };
        const r = options.setDestination(cmd.origin, cmd.enabled, cmd.expectedEnabled);
        return { ack: r.ok ? ok(id, 0) : failed(id, r.code) };
      }
      case "set_agent": {
        if (!options.setAgent) return { ack: failed(id, "unavailable") };
        const r = options.setAgent(cmd.agent);
        return { ack: r.ok ? ok(id, 0) : failed(id, r.code) };
      }
      case "refresh_capabilities":
        options.refreshCapabilities();
        return { ack: ok(id, 0) };
      case "open_link": {
        if (!options.results) return { ack: failed(id, "unavailable") };
        const { coreInstanceId, visitEpoch, jobId, candidateId } = cmd;
        const link = options.results.resolveLink({ coreInstanceId, visitEpoch, jobId, candidateId });
        if (!link.ok) return { ack: failed(id, link.code) };
        return { ack: { ...ok(id, 0), target: { href: link.href } } };
      }
    }
  }

  const emit = (ack: PanelAck, type: string): void => {
    diagnostics?.event("native_command", { type, ok: ack.ok, ...(ack.ok ? {} : { code: ack.code }) });
    options.emitAck(ack);
  };

  return {
    async handle(cmd, scope = "") {
      const { commandId, ...rest } = cmd;
      const fingerprint = JSON.stringify(rest);
      const key = `${scope}\u0000${commandId}`;
      const seen = cache.get(key);
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
      cache.set(key, { fingerprint, result: attempt });
      while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
      const { ack, cleanup } = await running;
      if (!ack.ok && cache.get(key)?.result === attempt) cache.delete(key);
      emit(ack, cmd.type);
      // The changed view follows the ack; the export outcome (conflicts) follows the sync.
      if (ack.ok && cmd.type !== "set_agent_browser_context" && cmd.type !== "set_destination" && cmd.type !== "refresh_capabilities" && cmd.type !== "open_link") {
        options.onStoreChanged();
        void cleanup?.then(options.onStoreChanged);
      }
    },
  };
}
