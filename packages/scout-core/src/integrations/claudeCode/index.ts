// The Claude Code integration: Scout's approved skills as native skill wrappers in the skills
// root the installer recorded (skillExporter.ts renders them with skillWrapper.ts).

import type { Diagnostics } from "../../diagnostics.js";
import { InstalledRecordError, readInstalledRecord } from "../../installedRecord.js";
import { createSkillExporter, ExportError, type SkillExporter } from "./skillExporter.js";

export type { SkillExporter } from "./skillExporter.js";

/**
 * The skill exporter for the skills root the installer recorded, or undefined when none is
 * recorded or the record or root is unusable (reported to diagnostics, never fatal).
 */
export function openExporter(home: string, diagnostics: Diagnostics): SkillExporter | undefined {
  let skillsRoot: string | undefined;
  try {
    skillsRoot = readInstalledRecord(home).skillsRoot;
  } catch (e) {
    diagnostics.event("installed_record_invalid", { code: e instanceof InstalledRecordError ? e.code : "installed-unreadable" });
    return undefined;
  }
  if (skillsRoot === undefined) return undefined;
  try {
    return createSkillExporter({ scoutHome: home, skillsRoot, diagnostics });
  } catch (e) {
    diagnostics.event("skills_root_invalid", { code: e instanceof ExportError ? e.code : "unknown" });
    return undefined;
  }
}
