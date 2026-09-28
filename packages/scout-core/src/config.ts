// Core configuration read from <scoutHome>/config.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DESTINATIONS: readonly string[] = ["docs.stripe.com", "www.peakdesign.com"];

export class ConfigError extends Error {
  constructor(readonly code: "config-unreadable" | "config-invalid-destinations") {
    super(code);
    this.name = "ConfigError";
  }
}

/**
 * Reads `destinations` from <scoutHome>/config.json. A missing file or a missing field
 * means the defaults; a present but malformed file or field is an error, not a fallback.
 */
export function readDestinations(home: string): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(join(home, "config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_DESTINATIONS;
    throw new ConfigError("config-unreadable");
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new ConfigError("config-unreadable");
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new ConfigError("config-unreadable");
  if (!("destinations" in cfg)) return DEFAULT_DESTINATIONS;
  const d = (cfg as { destinations: unknown }).destinations;
  if (!Array.isArray(d) || !d.every((x) => typeof x === "string")) throw new ConfigError("config-invalid-destinations");
  return d as string[];
}
