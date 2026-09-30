// Projects named by `repo:` frontmatter in a registry of markdown notes (the second brain's
// project notes). The registry is a map only: its notes are scanned for frontmatter here
// and never returned.
//
// Convention (as the second brain uses it): a note whose first frontmatter block has a
// `repo:` key names a project. The value may be a scalar (`repo: ~/x`), a flow list
// (`repo: [~/x, ~/y]`) or a block list (`repo:` then `  - ~/x` lines). The first entry is
// the project's repo; later entries are ignored. `~` expands to HOME, and the result must
// be absolute. The project name is the note's file name without its extension; when two
// notes give the same name, the first in path order wins.
//
// A project is readable only when its name is in `enabledProjects`, neither its repo nor
// `<repo>/<subpath>` is too broad (`/`, $HOME or an ancestor of it), no directory on the
// way to `<repo>/<subpath>` has an always-excluded name (`~/.ssh`, `.git`, `secrets`, ...),
// and `<repo>/<subpath>` passes checkReadable (which repeats that check on the real path). It is then read as a markdown directory rooted
// at `<repo>/<subpath>`.

import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { checkReadable, isExcludedAncestry, isTooBroadRoot, type ExclusionOptions, type RegistryProjectsSource } from "../config.js";
import { nodeFs, readVerified, walkFiles, type FsOps, type TreeOptions } from "./markdownDir.js";

/** Bytes read from the top of each registry note when looking for frontmatter. */
export const FRONTMATTER_SCAN_BYTES = 8 * 1024;

const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const REGISTRY_EXTENSIONS = new Set([".md", ".markdown"]);

export type ProjectAvailability = "ok" | "disabled" | "not-found" | "repo-invalid" | "too-broad" | string;

export interface RegistryProject {
  name: string;
  enabled: boolean;
  availability: ProjectAvailability;
  /** Set only for an enabled, available project. */
  root?: string;
}

export interface RegistryView {
  /** checkReadable on the registry directory itself. */
  availability: "ok" | string;
  projects: RegistryProject[];
  truncated: boolean;
}

/** `v` up to a `#` that starts a comment (at the start or after whitespace, outside quotes), trimmed. */
function stripComment(v: string): string {
  let quote: string | undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(v[i - 1] ?? ""))) {
      return v.slice(0, i).trim();
    }
  }
  return v.trim();
}

/** A scalar with matching outer quotes removed. Undefined for an unbalanced quote. */
function unquote(v: string): string | undefined {
  const t = v.trim();
  const q = t[0];
  if (q === '"' || q === "'") return t.length >= 2 && t.endsWith(q) && !t.slice(1, -1).includes(q) ? t.slice(1, -1) : undefined;
  return t;
}

/** Split a flow list's inside on commas outside quotes. Undefined for an unbalanced quote. */
function splitFlow(inner: string): string[] | undefined {
  const items: string[] = [];
  let quote: string | undefined;
  let cur = "";
  for (const c of inner) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (quote !== undefined) return undefined;
  items.push(cur);
  return items;
}

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

/**
 * The first `repo:` entry of the note's first frontmatter block, unexpanded, or undefined.
 * Trailing `# comments` are dropped, quotes are honored (a quoted item may hold commas or
 * `#`), and blank lines inside a block list are skipped. Anything malformed is undefined.
 */
export function parseRepoFrontmatter(text: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]?.trim();
    if (l === "---" || l === "...") {
      close = i;
      break;
    }
  }
  if (close < 0) return undefined;
  const fm = lines.slice(1, close);
  for (let i = 0; i < fm.length; i++) {
    const m = /^repo:(.*)$/.exec(fm[i] ?? "");
    if (!m) continue;
    const value = stripComment(m[1] ?? "");
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) return undefined;
      const first = splitFlow(value.slice(1, -1))?.[0];
      return first === undefined ? undefined : nonEmpty(unquote(first));
    }
    if (value !== "") return nonEmpty(unquote(value));
    let j = i + 1;
    while (j < fm.length && (fm[j] ?? "").trim() === "") j++;
    const item = /^\s+-\s+(.+)$/.exec(fm[j] ?? "");
    if (!item) return undefined;
    return nonEmpty(unquote(stripComment(item[1] ?? "")));
  }
  return undefined;
}

function expandRepo(v: string, home: string): string | undefined {
  const expanded = v === "~" ? home : v.startsWith("~/") ? join(home, v.slice(2)) : v;
  if (!isAbsolute(expanded) || expanded.includes("\0")) return undefined;
  return resolve(expanded);
}

export interface RegistryOptions {
  exclusion?: ExclusionOptions;
  fs?: FsOps;
}

/**
 * Scan the registry for projects and decide which are readable. Enabled names with no
 * note are listed as `not-found`. Disabled projects are listed but never probed.
 */
export function discoverProjects(source: RegistryProjectsSource, opts: RegistryOptions = {}): RegistryView {
  const fs = opts.fs ?? nodeFs;
  const home = opts.exclusion?.home ?? (process.env.HOME || homedir());
  const copts = { ...opts.exclusion, realpath: fs.realpath };
  const rootCheck = checkReadable(source.registry, source.registry, copts);
  const enabled = new Set(source.enabledProjects);
  const found = new Map<string, string | undefined>(); // name -> expanded repo (undefined: invalid)
  let truncated = false;

  if (rootCheck.ok) {
    const tree: TreeOptions = { root: source.registry, fs };
    if (opts.exclusion !== undefined) tree.exclusion = opts.exclusion;
    const walked = walkFiles(tree);
    truncated = walked.truncated;
    for (const f of walked.files) {
      const ext = extname(f.rel).toLowerCase();
      if (!REGISTRY_EXTENSIONS.has(ext)) continue;
      const name = basename(f.rel, extname(f.rel));
      if (!PROJECT_NAME_RE.test(name) || name === "." || name === ".." || found.has(name)) continue;
      const r = readVerified(fs, f.realPath, FRONTMATTER_SCAN_BYTES);
      if (!r) continue;
      const raw = parseRepoFrontmatter(r.text);
      if (raw === undefined) continue;
      found.set(name, expandRepo(raw, home));
    }
  }

  const projects: RegistryProject[] = [];
  for (const [name, repo] of found) {
    if (!enabled.has(name)) {
      projects.push({ name, enabled: false, availability: "disabled" });
      continue;
    }
    if (repo === undefined) {
      projects.push({ name, enabled: true, availability: "repo-invalid" });
      continue;
    }
    const root = join(repo, ...source.subpath.split("/"));
    if (isTooBroadRoot(repo, home) || isTooBroadRoot(root, home)) {
      projects.push({ name, enabled: true, availability: "too-broad" });
      continue;
    }
    if (isExcludedAncestry(root, home)) {
      projects.push({ name, enabled: true, availability: "excluded" });
      continue;
    }
    const c = checkReadable(root, root, copts);
    projects.push(c.ok ? { name, enabled: true, availability: "ok", root } : { name, enabled: true, availability: c.code });
  }
  for (const name of enabled) {
    if (!found.has(name)) projects.push({ name, enabled: true, availability: "not-found" });
  }
  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { availability: rootCheck.ok ? "ok" : rootCheck.code, projects, truncated };
}
