// Everything the side panel shows: the link to the core, the core's status, results, the
// capability view, previews, command states, and the user's section and preview selection.
// A port of ScoutKit's PanelModel (native/Scout/Sources/ScoutKit/PanelModel.swift).
//
// Every event goes through `applyLink` / `apply`, every user action through a method that
// returns the commands to send. Nothing here changes the section or the shown preview except a
// user action, and Approve exists only for the shown, complete preview, so a list reordering
// under the pointer cannot redirect an approval.
//
// Browser mapping: the app's sidecar status becomes the worker's link to the core. "running" is
// a ready native port (`connected`); anything else is treated like a stopped sidecar (results,
// capabilities and the visit are dropped). A link that comes back is treated like a core
// restart: pending decisions are re-sent under their IDs (the core's command cache answers a
// duplicate), toggles settle `unknown`, loading previews start over. Pure: no `chrome.*`.

import type { AckFailureCode, PanelState } from "@scout/contracts";
import type { LinkState } from "../messages.js";
import { BLOCKER_TEXT, CapabilityModel, hostOf } from "./capabilities.js";
import { type CommandRecord, CommandTracker, isDecision, isMutation, isToggle, type PanelCommand, type SendOutcome } from "./commands.js";
import type { LinkRefusal } from "./links.js";
import { PauseState } from "./pause.js";
import { keyId, PreviewAssembler, type PreviewFailure, type PreviewKey, sameKey } from "./preview.js";
import { type CoreStatus, displaySummary, type LinkOpenRequest, type ResultsDisplay, ResultsModel } from "./results.js";

export type PanelSection = "results" | "sites" | "site" | "settings" | "activity" | "problems";
export const SECTIONS: ReadonlyArray<{ id: PanelSection; title: string }> = [
  { id: "results", title: "Results" },
  { id: "sites", title: "Sites" },
  { id: "site", title: "This site" },
  { id: "settings", title: "Settings" },
  { id: "activity", title: "Activity" },
  { id: "problems", title: "Problems" },
];

export type Problem =
  | { kind: "link"; text: string }
  | { kind: "conflict"; conflict: CapabilityModel["conflicts"][number] }
  | { kind: "command"; record: CommandRecord }
  | { kind: "preview"; key: PreviewKey; failure: PreviewFailure }
  /** The core answered a click with a target the panel would not open, or Chrome did not open it. */
  | { kind: "linkRefused"; commandId: string; refusal: LinkRefusal };

const LINK_PROBLEM: Partial<Record<LinkState, string>> = {
  disconnected: "Scout's native host isn't reachable. Check that Scout is installed, then Reconnect in Settings.",
  core_unavailable: "Scout isn't running. Start the Scout app; the panel reconnects on its own.",
  upgrade_required: "Scout's parts are different versions. Run Scout's setup again, then reload the extension.",
};

export const MISSING_CAPABILITIES = "Scout core's list of site offers and approvals didn't arrive, so This site can't show them. Refresh in Settings to try again.";

export class PanelModel {
  static readonly previewCapacity = 8;

  link: LinkState = "connecting";
  detail: string | null = null;
  permitted: boolean | null = null;
  readonly resultsModel = new ResultsModel();
  readonly capabilities = new CapabilityModel();
  readonly pauseState = new PauseState();
  section: PanelSection = "results";
  /** The preview in the This site pane; changes only by a user action. */
  shownPreview: PreviewKey | null = null;
  readonly previews = new Map<string, PreviewAssembler>();
  /** Oldest first, for eviction (key ids). */
  private previewOrder: string[] = [];
  /** The `preview` command each loading preview waits on. */
  private awaiting = new Map<string, string>();
  /** Versions decided (ok ack) since the last `capabilities` frame. */
  private decidedSinceFrame = new Set<string>();
  private revokedSinceFrame = new Set<string>();
  private dismissed = new Set<string>();

  constructor(readonly commands: CommandTracker = new CommandTracker()) {}

  get running(): boolean {
    return this.link === "connected";
  }

  get core(): CoreStatus | null {
    return this.pauseState.core;
  }

  // ---------- events ----------

  /** The worker's link to the core. Returns the commands to send when it (re)connects. */
  applyLink(link: LinkState): PanelCommand[] {
    const wasRunning = this.running;
    this.link = link;
    if (!this.running) {
      this.pauseState.coreStopped();
      this.detail = null;
      this.permitted = null;
      this.resultsModel.coreStopped();
      this.capabilities.reset();
      this.decidedSinceFrame.clear();
      this.revokedSinceFrame.clear();
      return [];
    }
    return wasRunning ? [] : this.coreRestarted();
  }

  private coreRestarted(): PanelCommand[] {
    this.resultsModel.reset();
    this.pauseState.coreRestarted();
    const out = this.commands.coreRestarted();
    for (const id of this.previewOrder) {
      const a = this.previews.get(id);
      if (a?.phase === "loading") {
        const c = this.startPreview(a.key);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** One frame from the core. Returns the commands to send (the next preview chunk request). */
  apply(state: PanelState): PanelCommand[] {
    switch (state.type) {
      case "state":
        this.resultsModel.applyState(state.status, state.visitEpoch ?? null, state.jobId ?? null);
        this.pauseState.apply(state.status);
        this.detail = state.detail ?? null;
        this.permitted = state.permitted ?? null;
        break;
      case "results":
        if (this.running) this.resultsModel.applyResults(state, this.capabilities.capabilities?.coreInstanceId ?? null, this.core);
        break;
      case "capabilities": {
        const previous = this.capabilities.capabilities?.coreInstanceId;
        if (this.capabilities.apply(state)) {
          this.decidedSinceFrame.clear();
          this.revokedSinceFrame.clear();
          this.settleMoot();
          // Another core answered without the panel seeing the link drop: treat it as a restart.
          if (previous !== undefined && previous !== state.coreInstanceId) return this.coreRestarted();
        }
        break;
      }
      case "preview":
        return this.receive(state);
      case "ack": {
        const wasPending = this.commands.record(state.commandId)?.state === "pending";
        const record = this.commands.apply(state);
        if (!record) break;
        const r = record.request;
        if (r.type === "open_link" && state.ok) this.resultsModel.linkAcked(state.commandId, state.target?.href, wasPending);
        else if (r.type === "preview" && !state.ok) {
          const id = keyId(r);
          if (this.awaiting.get(id) === state.commandId) {
            this.awaiting.delete(id);
            this.previews.get(id)?.refused(state.code);
          }
        } else if ((r.type === "approve" || r.type === "decline") && state.ok) this.decidedSinceFrame.add(keyId(r));
        else if (r.type === "revoke" && state.ok) this.revokedSinceFrame.add(r.resourceId);
        else if (!state.ok && state.code === "stale_revision" && (isToggle(r) || isDecision(r))) this.settleMoot();
        break;
      }
      case "audit":
        this.capabilities.applyAudit(state.entries);
        break;
      case "grant":
        this.capabilities.applyGrant(state.agentBrowserContext, state.destinations ?? []);
        this.settleMoot();
        break;
    }
    return [];
  }

  /** A stale refusal whose target the latest frame already shows did what the user wanted: settle it. */
  private settleMoot(): void {
    for (const rec of this.commands.records) {
      if (rec.state !== "failed" || rec.code !== "stale_revision") continue;
      const r = rec.request;
      const entry = "resourceId" in r ? this.capabilities.libraryEntry(r.resourceId) : undefined;
      let moot = false;
      if (r.type === "approve") moot = entry?.state === "approved" && entry.defaultVersion === r.version;
      else if (r.type === "decline") moot = entry?.versions.some((v) => v.hash === r.version && v.state === "declined") === true;
      else if (r.type === "revoke") moot = entry?.state === "blocked";
      else if (r.type === "set_auto_acquire") moot = this.capabilities.originSetting(r.origin)?.autoAcquire === r.enabled;
      else if (r.type === "set_agent_browser_context") moot = this.capabilities.agentBrowserContext === r.enabled;
      if (moot) this.commands.settle(rec.id);
    }
  }

  private receive(chunk: Extract<PanelState, { type: "preview" }>): PanelCommand[] {
    this.commands.chunkArrived(chunk.commandId);
    const id = keyId(chunk);
    const assembler = this.previews.get(id);
    if (this.awaiting.get(id) !== chunk.commandId || !assembler) return [];
    this.awaiting.delete(id);
    assembler.accept(chunk);
    const next = assembler.requestNext();
    if (!next) return [];
    const command = this.commands.issue(next);
    this.awaiting.set(id, command.commandId);
    return [command];
  }

  /** Previews whose last chunk arrived and whose hash the adapter must check (WebCrypto). */
  previewsToVerify(): PreviewAssembler[] {
    return [...this.previews.values()].filter((a) => a.phase === "verifying");
  }

  /** The SHA-256 (hex) of a verifying preview's bytes. */
  previewVerified(key: PreviewKey, digest: string): void {
    this.previews.get(keyId(key))?.verified(digest);
  }

  // ---------- results ----------

  get visitEpoch(): number | null {
    return this.resultsModel.visitEpoch;
  }

  get results() {
    return this.resultsModel.phase;
  }

  get resultsDisplay(): ResultsDisplay {
    if (!this.running) return { kind: "none" };
    return this.resultsModel.display(this.core);
  }

  openResult(candidateId: string): PanelCommand | null {
    if (!this.running) return null;
    return this.resultsModel.openResult(candidateId, this.commands);
  }

  linkRecord(candidateId: string): CommandRecord | undefined {
    return this.resultsModel.linkRecord(candidateId, this.commands);
  }

  takeLinksToOpen(): LinkOpenRequest[] {
    return this.resultsModel.takeLinksToOpen();
  }

  linkRefused(commandId: string, refusal: LinkRefusal): void {
    this.resultsModel.linkRefused(commandId, refusal);
  }

  // ---------- user actions ----------

  select(section: PanelSection): void {
    this.section = section;
  }

  /** Shows `key` in the This site pane, loading it unless it is loaded or loading. */
  showPreview(key: PreviewKey): PanelCommand | null {
    this.shownPreview = { resourceId: key.resourceId, version: key.version };
    this.select("site");
    const a = this.previews.get(keyId(key));
    if (a?.phase === "complete" || a?.phase === "verifying") return null;
    if (a?.phase === "loading" && this.awaiting.has(keyId(key))) return null;
    return this.startPreview(key);
  }

  /** Closes the preview pane (a user action). */
  closePreview(): void {
    this.shownPreview = null;
  }

  restartPreview(key: PreviewKey): PanelCommand | null {
    return this.startPreview(key);
  }

  preview(key: PreviewKey): PreviewAssembler | undefined {
    return this.previews.get(keyId(key));
  }

  approveBlocker(key: PreviewKey): string | null {
    if (!this.running) return "Scout isn't connected.";
    const d = this.decisionBlocker(key);
    if (d) return d;
    const b = this.capabilities.approvalBlocker(key);
    if (b) return BLOCKER_TEXT[b];
    switch (this.previews.get(keyId(key))?.phase) {
      case "complete":
        return sameKey(this.shownPreview, key) ? null : "Open this version in the preview to approve it.";
      case "loading":
      case "verifying":
        return "Preview is still loading.";
      case "failed":
        return "Preview failed; load it again to approve.";
      case undefined:
        return "Preview this version before approving it.";
    }
  }

  canApprove(key: PreviewKey): boolean {
    return this.approveBlocker(key) === null;
  }

  canDecline(key: PreviewKey): boolean {
    return this.running && this.decisionBlocker(key) === null && this.capabilities.offer(key) !== undefined;
  }

  approve(key: PreviewKey): PanelCommand | null {
    const revision = this.capabilities.resourceRevision(key.resourceId);
    if (!this.canApprove(key) || revision === undefined) return null;
    return this.commands.issue({ type: "approve", resourceId: key.resourceId, version: key.version, expectedRevision: revision });
  }

  decline(key: PreviewKey): PanelCommand | null {
    const revision = this.capabilities.resourceRevision(key.resourceId);
    if (!this.canDecline(key) || revision === undefined) return null;
    return this.commands.issue({ type: "decline", resourceId: key.resourceId, version: key.version, expectedRevision: revision });
  }

  canRevoke(resourceId: string): boolean {
    const entry = this.capabilities.libraryEntry(resourceId);
    if (!this.running || !entry || entry.state === "blocked") return false;
    if (this.revokedSinceFrame.has(resourceId)) return false;
    return this.revokeRecord(resourceId)?.state !== "pending";
  }

  revoke(resourceId: string): PanelCommand | null {
    const entry = this.capabilities.libraryEntry(resourceId);
    if (!this.canRevoke(resourceId) || !entry) return null;
    return this.commands.issue({ type: "revoke", resourceId, expectedRevision: entry.resourceRevision });
  }

  canToggleAutoAcquire(origin: string): boolean {
    const setting = this.capabilities.originSetting(origin);
    if (!this.running || this.autoAcquireRecord(origin)?.state === "pending" || !setting) return false;
    return setting.autoAcquire || setting.permitted;
  }

  /** Turning auto-acquire on needs a site Chrome permits and the user's acknowledgement of the risk. */
  setAutoAcquire(origin: string, enabled: boolean, acknowledgeRisk: boolean): PanelCommand | null {
    const setting = this.capabilities.originSetting(origin);
    if (!this.canToggleAutoAcquire(origin) || !setting || setting.autoAcquire === enabled) return null;
    if (enabled && !(acknowledgeRisk && setting.permitted)) return null;
    return this.commands.issue({ type: "set_auto_acquire", origin, enabled, acknowledgeRisk: enabled && acknowledgeRisk, expectedEnabled: setting.autoAcquire });
  }

  get canToggleGrant(): boolean {
    return this.running && this.capabilities.agentBrowserContext !== null && this.grantRecord?.state !== "pending";
  }

  setAgentBrowserContext(enabled: boolean): PanelCommand | null {
    const current = this.capabilities.agentBrowserContext;
    if (!this.canToggleGrant || current === null || current === enabled) return null;
    return this.commands.issue({ type: "set_agent_browser_context", enabled, expectedEnabled: current });
  }

  refreshCapabilities(): PanelCommand | null {
    return this.running ? this.commands.issue({ type: "refresh_capabilities" }) : null;
  }

  canRetry(commandId: string): boolean {
    return this.commands.canRetry(commandId);
  }

  retry(commandId: string): PanelCommand | null {
    const c = this.commands.retry(commandId);
    if (!c) return null;
    this.dismissed.delete(commandId);
    return c;
  }

  dismiss(commandId: string): void {
    this.resultsModel.dismissLink(commandId);
    if (this.commands.record(commandId)?.state !== "failed") return;
    this.dismissed.add(commandId);
    for (const id of [...this.dismissed]) if (!this.commands.record(id)) this.dismissed.delete(id);
  }

  /** Commands the core never answered (commands.ts PENDING_TIMEOUT_MS); a preview's fails it. A pause or resume no frame confirmed settles to the core's state. */
  expirePending(now: number): void {
    this.pauseState.expire(now);
    for (const r of this.commands.expire(now)) {
      if (r.request.type !== "preview") continue;
      const id = keyId(r.request);
      if (this.awaiting.get(id) === r.id) {
        this.awaiting.delete(id);
        this.previews.get(id)?.refused("unavailable");
      }
    }
  }

  /** What became of a write; an oversize preview request fails its preview. */
  markSent(command: PanelCommand, outcome: SendOutcome, now = 0): void {
    this.commands.markSent(command.commandId, outcome, now);
    if ((outcome !== "oversize" && outcome !== "invalid") || command.type !== "preview") return;
    const id = keyId(command);
    if (this.awaiting.get(id) === command.commandId) {
      this.awaiting.delete(id);
      this.previews.get(id)?.refused("invalid");
    }
  }

  // ---------- command lookups ----------

  decisionRecord(key: PreviewKey): CommandRecord | undefined {
    return this.commands.latest((r) => (r.type === "approve" || r.type === "decline") && r.resourceId === key.resourceId && r.version === key.version);
  }

  revokeRecord(resourceId: string): CommandRecord | undefined {
    return this.commands.latest((r) => r.type === "revoke" && r.resourceId === resourceId);
  }

  autoAcquireRecord(origin: string): CommandRecord | undefined {
    return this.commands.latest((r) => r.type === "set_auto_acquire" && r.origin === origin);
  }

  get grantRecord(): CommandRecord | undefined {
    return this.commands.latest((r) => r.type === "set_agent_browser_context");
  }

  private decisionBlocker(key: PreviewKey): string | null {
    if (this.decidedSinceFrame.has(keyId(key))) return "Decision recorded.";
    if (this.decisionRecord(key)?.state === "pending") return "Waiting for Scout core.";
    return null;
  }

  // ---------- derived views ----------

  /** The site of the core's current visit, when Chrome permits it. */
  get currentHost(): string | null {
    if (this.core !== "idle" || this.permitted === false || !this.detail) return null;
    return this.detail;
  }

  get currentOffers() {
    const h = this.currentHost;
    return h === null ? [] : this.capabilities.offersForHost(h);
  }

  get problems(): Problem[] {
    const out: Problem[] = [];
    const linkText = LINK_PROBLEM[this.link];
    if (linkText) out.push({ kind: "link", text: linkText });
    // The core repaints grant, capabilities, audit, then state: a state without capabilities
    // means that frame never arrived (one over the relay's 1 MiB cap is dropped by the core).
    if (this.missingCapabilities) out.push({ kind: "link", text: MISSING_CAPABILITIES });
    for (const conflict of this.capabilities.conflicts) out.push({ kind: "conflict", conflict });
    const failed = this.commands.records.filter((r) => r.state === "failed" && !this.dismissed.has(r.id) && isMutation(r.request));
    for (const record of failed.reverse()) out.push({ kind: "command", record });
    for (const r of [...this.resultsModel.linkRefusals].reverse()) out.push({ kind: "linkRefused", commandId: r.commandId, refusal: r.refusal });
    for (const id of [...this.previewOrder].reverse()) {
      const a = this.previews.get(id);
      if (a?.phase === "failed" && a.failure) out.push({ kind: "preview", key: a.key, failure: a.failure });
    }
    return out;
  }

  /** Connected and the core has reported its state, but no `capabilities` frame arrived. */
  get missingCapabilities(): boolean {
    return this.running && this.core !== null && this.capabilities.capabilities === null;
  }

  /** Link and core status plus the current host. */
  get statusLine(): string {
    switch (this.link) {
      case "connecting":
        return "Connecting…";
      case "disconnected":
        return "Not connected";
      case "core_unavailable":
        return "Scout isn't running";
      case "upgrade_required":
        return "Update needed";
      case "connected":
        break;
    }
    const parts = [this.core ? this.core[0]!.toUpperCase() + this.core.slice(1) : "Connected"];
    const host = this.currentHost ?? this.detail;
    if (host) parts.push(host);
    return parts.join(" · ");
  }

  /** The panel header: status, current host, offer count, results summary. */
  get headerLine(): string {
    const parts = [this.statusLine];
    const n = this.currentOffers.length;
    if (n > 0) parts.push(n === 1 ? "1 offer" : `${n} offers`);
    const d = this.resultsDisplay;
    const summary = d.kind === "paused" || d.kind === "disconnected" ? null : displaySummary(d);
    if (summary) parts.push(summary);
    return parts.join(" · ");
  }

  // ---------- previews ----------

  private startPreview(key: PreviewKey): PanelCommand | null {
    const id = keyId(key);
    const assembler = new PreviewAssembler({ resourceId: key.resourceId, version: key.version });
    const request = assembler.requestNext();
    if (!request) return null;
    const old = this.awaiting.get(id);
    if (old !== undefined) {
      this.awaiting.delete(id);
      this.commands.supersede(old);
    }
    this.previews.set(id, assembler);
    this.previewOrder = this.previewOrder.filter((x) => x !== id);
    this.previewOrder.push(id);
    while (this.previewOrder.length > PanelModel.previewCapacity) {
      const shown = this.shownPreview ? keyId(this.shownPreview) : null;
      const evict = this.previewOrder.find((x) => x !== shown);
      if (evict === undefined) break;
      this.previewOrder = this.previewOrder.filter((x) => x !== evict);
      this.previews.delete(evict);
      const was = this.awaiting.get(evict);
      if (was !== undefined) {
        this.awaiting.delete(evict);
        this.commands.supersede(was);
      }
    }
    if (!this.running || !this.previews.has(id)) return null;
    const command = this.commands.issue(request);
    this.awaiting.set(id, command.commandId);
    return command;
  }
}

/** Short text for an ack failure code, for Problems. */
export const ACK_CODE_TEXT: Record<AckFailureCode, string> = {
  stale_revision: "something changed meanwhile",
  not_found: "Scout core doesn't know it",
  invalid: "the request was not valid",
  store_error: "Scout couldn't save it",
  not_permitted: "Chrome doesn't allow Scout on that site",
  unavailable: "Scout core couldn't do it right now",
};

export { hostOf };
