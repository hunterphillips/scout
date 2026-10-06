// The static `scout-integration` skill: its template, the skills-root checks, and the
// hash-checked inspect / write / remove of `<skillsRoot>/scout-integration/SKILL.md`.
//
// Ownership is the SHA-256 of the file's content, recorded in installed.json. A skill dir is
// Scout's only when it is a real directory (not a symlink) holding exactly SKILL.md, opened
// with O_NOFOLLOW, whose content hashes to an accepted value; anything else is left in place.
// Runtime wrappers (`<skillsRoot>/scout-*`, owned by scout-core via capabilities/exports.json)
// are never touched here; countRuntimeWrappers only reports them.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { REPO_ROOT } from "./paths.mjs";
import { INTEGRATION_SKILL_DIR, integrationSkillPath } from "./installed.mjs";
import { writeFileMode } from "./files.mjs";

export const SKILL_FILE = "SKILL.md";
export const SKILL_TEMPLATE = join(REPO_ROOT, "scripts", "templates", INTEGRATION_SKILL_DIR, SKILL_FILE);
/** Larger files are not Scout's skill. */
const SKILL_MAX_BYTES = 64 * 1024;

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The template text and its hash. */
export function skillTemplate() {
  const text = readFileSync(SKILL_TEMPLATE, "utf8");
  return { text, sha256: sha256(text) };
}

export const skillDir = (skillsRoot) => join(skillsRoot, INTEGRATION_SKILL_DIR);
export { integrationSkillPath };

/**
 * Check a skills root without changing anything. It must be absolute and, where it exists,
 * a real directory (not a symlink, no symlinked ancestor) owned by the current user; where it
 * does not, its nearest existing ancestor must be a real directory. Throws with a reason;
 * returns { exists }.
 */
export function checkSkillsRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) throw new Error(`skills root ${root} is not an absolute path`);
  let probe = root;
  for (;;) {
    let st;
    try {
      st = lstatSync(probe);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const up = dirname(probe);
      if (up === probe) throw new Error(`skills root ${root} has no existing ancestor`);
      probe = up;
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`skills root ${probe === root ? root : `ancestor ${probe}`} is a symlink`);
    if (!st.isDirectory()) throw new Error(`${probe} is not a directory`);
    if (realpathSync(probe) !== probe) throw new Error(`skills root ${root} has a symlinked ancestor (resolves to ${realpathSync(probe)}${root.slice(probe.length)})`);
    if (probe === root && st.uid !== process.getuid()) throw new Error(`skills root ${root} is not owned by the current user`);
    return { exists: probe === root };
  }
}

/**
 * What is at `<skillsRoot>/scout-integration` now. Never throws. Returns { state, sha256? }:
 *   absent     nothing there
 *   empty      a real, empty directory (a crash between mkdir and write)
 *   file       a real directory holding exactly SKILL.md; `sha256` is its content hash
 *   symlink    the dir or its SKILL.md is a symlink
 *   other      anything else (a file, extra entries, an oversized or non-regular SKILL.md)
 *   error_<code>
 */
export function inspectSkill(dir) {
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      return e?.code === "ENOENT" ? { state: "absent" } : { state: errorCode(e) };
    }
    if (st.isSymbolicLink()) return { state: "symlink" };
    if (!st.isDirectory()) return { state: "other" };
    const entries = readdirSync(dir);
    if (entries.length === 0) return { state: "empty", ino: st.ino, dev: st.dev };
    if (entries.length !== 1 || entries[0] !== SKILL_FILE) return { state: "other" };
    let fd;
    try {
      fd = openSync(join(dir, SKILL_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e?.code === "ELOOP") return { state: "symlink" };
      return e?.code === "ENOENT" ? { state: "other" } : { state: errorCode(e) };
    }
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.size > SKILL_MAX_BYTES) return { state: "other" };
      return { state: "file", sha256: sha256(readFileSync(fd, "utf8")), ino: st.ino, dev: st.dev };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return { state: e?.code === "ENOENT" ? "other" : errorCode(e) };
  }
}

/**
 * Create the skills root (0700 when created) and write SKILL.md (0600) in a 0700 dir. The
 * caller has checked ownership. Returns { rootCreated }: true only when this call created the
 * skills root itself (mkdirSync reported a created path).
 */
export function writeSkill(skillsRoot, text) {
  const { exists } = checkSkillsRoot(skillsRoot);
  // With `recursive`, mkdirSync returns the first directory it created, or undefined when the
  // leaf already existed (a racing creator); any created path means the leaf was created too.
  const rootCreated = !exists && mkdirSync(skillsRoot, { recursive: true, mode: 0o700 }) !== undefined;
  checkSkillsRoot(skillsRoot);
  const dir = skillDir(skillsRoot);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  chmodSync(dir, 0o700);
  writeFileMode(join(dir, SKILL_FILE), text, 0o600);
  return { rootCreated };
}

/**
 * Remove the skill dir only if it holds exactly our SKILL.md with hash `expected` (or is the
 * empty dir a crash left). Never throws. Returns `removed` | `absent` | `left_modified` |
 * `left_symlink` | `error_<code>`. The dir must be the same inode when it acts.
 */
export function removeSkill(skillsRoot, expected) {
  const dir = skillDir(skillsRoot);
  const seen = inspectSkill(dir);
  if (seen.state === "absent") return "absent";
  if (seen.state === "symlink") return "left_symlink";
  if (seen.state.startsWith("error_")) return seen.state;
  if (seen.state === "other" || (seen.state === "file" && seen.sha256 !== expected)) return "left_modified";
  try {
    const again = lstatSync(dir);
    if (again.isSymbolicLink()) return "left_symlink";
    if (again.ino !== seen.ino || again.dev !== seen.dev) return "left_modified";
    if (seen.state === "file") unlinkSync(join(dir, SKILL_FILE));
    rmdirSync(dir);
    return "removed";
  } catch (e) {
    return e?.code === "ENOENT" || e?.code === "ENOTEMPTY" ? "left_modified" : errorCode(e);
  }
}

/**
 * The skills root, wrapper count and wrapper names scout-core's exports manifest records (shape in
 * packages/scout-core/src/integrations/claudeCode/skillExporter.ts). Read-only; returns null when the manifest
 * does not exist and throws when it exists but cannot be read or has no skillsRoot / entries.
 */
export function readExportsManifest(exportsManifest) {
  let data;
  try {
    data = JSON.parse(readFileSync(exportsManifest, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`${exportsManifest} is unreadable`);
  }
  if (typeof data?.skillsRoot !== "string" || !Array.isArray(data.entries)) throw new Error(`${exportsManifest} has no skillsRoot or entries`);
  const names = data.entries.map((e) => e?.name).filter((n) => typeof n === "string" && /^scout-[a-z0-9-]+$/.test(n));
  return { skillsRoot: data.skillsRoot, wrappers: data.entries.length, names };
}

/**
 * Runtime wrapper dirs scout-core lists in `exportsManifest` that still exist under
 * `skillsRoot`. Read-only; returns { count, manifest } or { count: null } when the manifest
 * is missing or unreadable.
 */
export function countRuntimeWrappers(exportsManifest, skillsRoot) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(exportsManifest, "utf8"))?.entries;
  } catch (e) {
    return e?.code === "ENOENT" ? { count: 0, manifest: exportsManifest } : { count: null, manifest: exportsManifest };
  }
  if (!Array.isArray(entries)) return { count: null, manifest: exportsManifest };
  const names = entries.map((e) => e?.name).filter((n) => typeof n === "string" && /^scout-[a-z0-9-]+$/.test(n));
  const count = names.filter((n) => {
    try {
      lstatSync(join(skillsRoot, n));
      return true;
    } catch {
      return false;
    }
  }).length;
  return { count, manifest: exportsManifest };
}

function errorCode(e) {
  const raw = e?.code ?? e?.name;
  return `error_${typeof raw === "string" && /^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : "unknown"}`;
}
