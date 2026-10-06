// Core configuration read from <scoutHome>/config.json.
//
// `destinations` is the list of hosts where recommendations are enabled. It does not decide
// which sites are visits or can have capabilities: that is Chrome's per-origin grant, reported
// by the extension's permissions snapshot. The core writes it too (`writeDestinations`, the
// side panel's per-site switch) and picks up a hand edit while it runs (wiring/destinations.ts).

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRANT_DESTINATIONS_MAX } from "@scout/contracts";
import { writeFileAtomic } from "./capabilities/atomicWrite.js";
import { CHROME_BUNDLE_ID } from "./visitTracker.js";

// Recommendations start off for every origin: a destination spends the user's agent quota on
// every settled visit there, so each one is the user's choice. `docs.stripe.com` and
// `www.peakdesign.com` are the acceptance examples a user adds to `destinations`.
export const DEFAULT_DESTINATIONS: readonly string[] = [];

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
  /** Hosts with recommendations enabled, e.g. "docs.stripe.com". Not a visit or capability gate. */
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
    if (!Array.isArray(d) || !d.every(isBareHost)) throw new ConfigError("config-invalid-destinations");
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

/** A bare host as URL parsing would print it: no scheme, path, or uppercase. */
function isBareHost(d: unknown): boolean {
  if (typeof d !== "string") return false;
  try {
    return new URL(`https://${d}`).host === d;
  } catch {
    return false;
  }
}

/** The `destinations` field alone; see readConfig. */
export function readDestinations(home: string): readonly string[] {
  return readConfig(home).destinations;
}

/** Why `writeDestinations` wrote nothing. */
export class DestinationsWriteError extends Error {
  constructor(
    readonly code:
      /** config.json is a symlink, a directory or anything but a regular file, or another user's. */
      | "not_regular"
      /** Unreadable, not JSON, not an object, or its `destinations` is malformed. */
      | "invalid"
      /** Enabling one more host would pass GRANT_DESTINATIONS_MAX. */
      | "full"
      | "io",
  ) {
    super(code);
    this.name = "DestinationsWriteError";
  }
}

/**
 * Turn recommendations for `host` on or off in config.json `destinations` and return the list as
 * written. The rest of the file is kept: every other key, unknown ones included, with its value
 * (re-serialized, two-space indent). The list is deduped in order; an enable appends. A missing
 * file becomes one holding only `destinations`. The write is atomic (a 0600 temp file renamed
 * over the target). Refuses (writing nothing) when config.json is not a regular file this user
 * owns, when it or its `destinations` is malformed, or when the list would pass
 * GRANT_DESTINATIONS_MAX. `check` gets the list read from disk before the change (the caller's
 * compare-and-set); when it returns false nothing is written and `written` is false.
 */
export function writeDestinations(home: string, host: string, enabled: boolean, check?: (current: readonly string[]) => boolean): { written: boolean; destinations: string[] } {
  const path = join(home, "config.json");
  let raw: string | null = null;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new DestinationsWriteError("not_regular");
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof DestinationsWriteError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new DestinationsWriteError("invalid");
  }
  let config: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DestinationsWriteError("invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DestinationsWriteError("invalid");
    config = parsed as Record<string, unknown>;
  }
  let current: string[] = [];
  if ("destinations" in config) {
    const d = config.destinations;
    if (!Array.isArray(d) || !d.every(isBareHost)) throw new DestinationsWriteError("invalid");
    current = [...new Set(d as string[])];
  }
  if (check && !check(current)) return { written: false, destinations: current };
  let next: string[];
  if (enabled) {
    if (current.includes(host)) next = current;
    else if (current.length >= GRANT_DESTINATIONS_MAX) throw new DestinationsWriteError("full");
    else next = [...current, host];
  } else next = current.filter((h) => h !== host);
  config.destinations = next;
  try {
    writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    throw new DestinationsWriteError("io");
  }
  return { written: true, destinations: next };
}
