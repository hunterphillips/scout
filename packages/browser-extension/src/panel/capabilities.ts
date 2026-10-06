// The core's latest capability view, browser-context grant and context-read audit. A port of
// ScoutKit's CapabilityModel.
// `capabilities` frames replace each other whole; a frame from the same core instance with a
// lower `revision` than the one held is stale and dropped; another `coreInstanceId` starts a
// new revision sequence. A `grant` frame also carries the sites with recommendations on
// (`destinations`; absent from an older core, which reads as none). The capabilities frame also
// carries Settings' agent choice (`agents`; absent from an older core). Pure: no `chrome.*`.

import type { CapabilityConflict, CapabilityOffer, LibraryEntry, OriginSetting, PanelAgents, PanelAudit, PanelCapabilities } from "@scout/contracts";
import type { PreviewKey } from "./preview.js";

export type ApprovalBlocker = "notOffered" | "alreadyApproved" | "siteNotPermitted";
export const BLOCKER_TEXT: Record<ApprovalBlocker, string> = {
  notOffered: "This version is no longer offered.",
  alreadyApproved: "This version is already approved.",
  siteNotPermitted: "Chrome does not give Scout access to this site right now.",
};

/** The hostname of an `https://host[:port]` origin, or null. */
export function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

export class CapabilityModel {
  capabilities: PanelCapabilities | null = null;
  /** What the latest `grant` frame said; null until one arrives. */
  agentBrowserContext: boolean | null = null;
  /** `https://host` origins with background recommendations on, from the latest `grant` frame. */
  destinations: readonly string[] = [];
  /** Oldest first. */
  audit: PanelAudit["entries"] = [];

  /** False for a stale frame. */
  apply(frame: PanelCapabilities): boolean {
    const held = this.capabilities;
    if (held && held.coreInstanceId === frame.coreInstanceId && frame.revision < held.revision) return false;
    this.capabilities = frame;
    return true;
  }

  applyGrant(enabled: boolean, destinations: readonly string[] = []): void {
    this.agentBrowserContext = enabled;
    this.destinations = destinations;
  }

  applyAudit(entries: PanelAudit["entries"]): void {
    this.audit = entries;
  }

  reset(): void {
    this.capabilities = null;
    this.agentBrowserContext = null;
    this.destinations = [];
    this.audit = [];
  }

  get offers(): CapabilityOffer[] {
    return this.capabilities?.offers ?? [];
  }
  get library(): LibraryEntry[] {
    return this.capabilities?.library ?? [];
  }
  get conflicts(): CapabilityConflict[] {
    return this.capabilities?.conflicts ?? [];
  }
  get origins(): OriginSetting[] {
    return this.capabilities?.origins ?? [];
  }
  /** Settings' agent choice; null before a frame, or from a core that sends none. */
  get agents(): PanelAgents | null {
    return this.capabilities?.agents ?? null;
  }

  /** Offers whose site is `host`. */
  offersForHost(host: string): CapabilityOffer[] {
    return this.offers.filter((o) => hostOf(o.siteOrigin) === host);
  }

  libraryForHost(host: string): LibraryEntry[] {
    return this.library.filter((e) => hostOf(e.siteOrigin) === host);
  }

  offer(key: PreviewKey): CapabilityOffer | undefined {
    return this.offers.find((o) => o.resourceId === key.resourceId && o.version === key.version);
  }

  libraryEntry(resourceId: string): LibraryEntry | undefined {
    return this.library.find((e) => e.resourceId === resourceId);
  }

  originSetting(origin: string): OriginSetting | undefined {
    return this.origins.find((o) => o.origin === origin);
  }

  /** Why `key` cannot be approved right now, or null when it can, given a complete preview. */
  approvalBlocker(key: PreviewKey): ApprovalBlocker | null {
    if (this.offer(key)) return null;
    const entry = this.libraryEntry(key.resourceId);
    const version = entry?.versions.find((v) => v.hash === key.version);
    if (!entry || !version) return "notOffered";
    // The library's explicit re-approval of a revoked resource; the core skips the origin check.
    if (entry.state === "blocked") return null;
    switch (version.state) {
      case "approved":
        return entry.defaultVersion === key.version ? "alreadyApproved" : null;
      case "pending":
        // An origin the frame does not list counts as not permitted.
        return this.originSetting(entry.siteOrigin)?.permitted === true ? null : "siteNotPermitted";
      case "declined":
      case "superseded":
        return null;
      case "revoked":
        return "notOffered";
    }
  }

  /** `expectedRevision` for a decision about `resourceId`: the offer's, else the library entry's. */
  resourceRevision(resourceId: string): number | undefined {
    return this.offers.find((o) => o.resourceId === resourceId)?.resourceRevision ?? this.libraryEntry(resourceId)?.resourceRevision;
  }
}
