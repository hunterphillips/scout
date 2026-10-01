// Core configuration read from <scoutHome>/config.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHROME_BUNDLE_ID } from "./visitTracker.js";

export const DEFAULT_DESTINATIONS: readonly string[] = ["docs.stripe.com", "www.peakdesign.com"];

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

export class ConfigError extends Error {
  constructor(
    readonly code:
      | "config-unreadable"
      | "config-invalid-destinations"
      | "config-invalid-chrome-bundle-id"
      | "config-invalid-agent-browser-context",
  ) {
    super(code);
    this.name = "ConfigError";
  }
}

export interface CoreConfig {
  /** Approved hostnames, e.g. "docs.stripe.com". */
  destinations: readonly string[];
  /** The bundle id treated as "Chrome frontmost", e.g. com.google.chrome.for.testing. */
  chromeBundleId: string;
  /**
   * The user's grant letting their agent read browser context (current site, site links,
   * recent activity) over agent.sock. Off by default.
   */
  agentBrowserContext: boolean;
}

/**
 * Reads <scoutHome>/config.json. A missing file or a missing field means that field's
 * default; a present but malformed file or field is an error, not a fallback.
 */
export function readConfig(home: string): CoreConfig {
  const defaults: CoreConfig = { destinations: DEFAULT_DESTINATIONS, chromeBundleId: CHROME_BUNDLE_ID, agentBrowserContext: false };
  let raw: string;
  try {
    raw = readFileSync(join(home, "config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw new ConfigError("config-unreadable");
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new ConfigError("config-unreadable");
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new ConfigError("config-unreadable");

  let destinations = defaults.destinations;
  if ("destinations" in cfg) {
    const d = (cfg as { destinations: unknown }).destinations;
    if (!Array.isArray(d) || !d.every((x) => typeof x === "string")) throw new ConfigError("config-invalid-destinations");
    destinations = d as string[];
  }

  let chromeBundleId = defaults.chromeBundleId;
  if ("chromeBundleId" in cfg) {
    const b = (cfg as { chromeBundleId: unknown }).chromeBundleId;
    if (typeof b !== "string" || !BUNDLE_ID_PATTERN.test(b)) throw new ConfigError("config-invalid-chrome-bundle-id");
    chromeBundleId = b;
  }

  let agentBrowserContext = defaults.agentBrowserContext;
  if ("agentBrowserContext" in cfg) {
    const g = (cfg as { agentBrowserContext: unknown }).agentBrowserContext;
    if (typeof g !== "boolean") throw new ConfigError("config-invalid-agent-browser-context");
    agentBrowserContext = g;
  }

  return { destinations, chromeBundleId, agentBrowserContext };
}

/** The `destinations` field alone; see readConfig. */
export function readDestinations(home: string): readonly string[] {
  return readConfig(home).destinations;
}
