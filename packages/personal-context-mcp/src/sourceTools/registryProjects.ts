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
// `<repo>/<subpath>` is too broad (`/`, $HOME or an ancestor of it), and
// `<repo>/<subpath>` passes checkReadable. It is then read as a markdown directory rooted
// at `<repo>/<subpath>`.

import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { checkReadable, isTooBroadRoot, type ExclusionOptions, type RegistryProjectsSource } from "../config.js";
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

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  const hash = t.search(/\s#/);
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

/** The first `repo:` entry of the note's first frontmatter block, unexpanded, or undefined. */
export function parseRepoFrontmatter(text: string): string | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
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
    const value = (m[1] ?? "").trim();
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) return undefined;
      const first = value.slice(1, -1).split(",")[0];
      const v = first === undefined ? "" : unquote(first);
      return v === "" ? undefined : v;
    }
    if (value !== "") {
      const v = unquote(value);
      return v === "" ? undefined : v;
    }
    const item = /^\s+-\s+(.+)$/.exec(fm[i + 1] ?? "");
    if (!item) return undefined;
    const v = unquote(item[1] ?? "");
    return v === "" ? undefined : v;
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
    const c = checkReadable(root, root, copts);
    projects.push(c.ok ? { name, enabled: true, availability: "ok", root } : { name, enabled: true, availability: c.code });
  }
  for (const name of enabled) {
    if (!found.has(name)) projects.push({ name, enabled: true, availability: "not-found" });
  }
  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { availability: rootCheck.ok ? "ok" : rootCheck.code, projects, truncated };
}
