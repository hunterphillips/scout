// The installer's record, <scoutHome>/installed.json. The core reads one field from it:
// `skillsRoot`, the directory Scout's skill wrappers are exported into. The root comes only
// from this record, never from a command line or an environment guess (see
// capabilities/capabilityCli.ts). The installer (P2.6) writes it; until then it is absent.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALLED_RECORD_FILE = "installed.json";

export class InstalledRecordError extends Error {
  constructor(readonly code: "installed-unreadable" | "installed-invalid-skills-root") {
    super(code);
    this.name = "InstalledRecordError";
  }
}

export interface InstalledRecord {
  skillsRoot?: string;
}

/**
 * Reads <scoutHome>/installed.json. A missing file or field means absent; a present but
 * malformed file or field is an error, not a fallback (the caller decides what absent means).
 */
export function readInstalledRecord(home: string): InstalledRecord {
  let raw: string;
  try {
    raw = readFileSync(join(home, INSTALLED_RECORD_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new InstalledRecordError("installed-unreadable");
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new InstalledRecordError("installed-unreadable");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new InstalledRecordError("installed-unreadable");
  if (!("skillsRoot" in record)) return {};
  const root = (record as { skillsRoot: unknown }).skillsRoot;
  if (typeof root !== "string" || root === "") throw new InstalledRecordError("installed-invalid-skills-root");
  return { skillsRoot: root };
}
