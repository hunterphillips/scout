import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { homeOf, pathWithCliDir, resolveExecutable, versionedBins, VERSIONED_BINS_MAX, withCliDirOnPath } from "./executables.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "scout-exec-"));
  dirs.push(d);
  return d;
}
function file(path: string, mode = 0o755): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, mode);
  return path;
}

describe("executable lookup with fallbacks", () => {
  it("finds a fallback when PATH has nothing, skips a non-executable one, and PATH wins over fallbacks", () => {
    const d = temp();
    const empty = join(d, "empty");
    mkdirSync(empty);
    const plain = file(join(d, "a", "tool"), 0o644);
    const runnable = file(join(d, "b", "tool"));
    expect(resolveExecutable("tool", empty, [plain, runnable])).toBe(runnable);
    expect(resolveExecutable("tool", empty, [plain])).toBeUndefined();
    expect(resolveExecutable("tool", "", [join(d, "missing", "tool")])).toBeUndefined();
    const onPath = file(join(d, "path", "tool"));
    expect(resolveExecutable("tool", `${empty}:${join(d, "path")}`, [runnable])).toBe(onPath);
  });

  it("ignores relative fallbacks and directories", () => {
    const d = temp();
    mkdirSync(join(d, "dir", "tool"), { recursive: true });
    expect(resolveExecutable("tool", "", ["relative/tool", join(d, "dir", "tool")])).toBeUndefined();
  });

  it("lists version bins newest first by numeric order, bounded, from a plain listing", () => {
    const d = temp();
    const root = join(d, "versions");
    for (const v of ["v9.1.0", "v22.17.0", "v24.18.0", ".hidden"]) mkdirSync(join(root, v), { recursive: true });
    expect(versionedBins(root, "tool")).toEqual([join(root, "v24.18.0", "bin", "tool"), join(root, "v22.17.0", "bin", "tool"), join(root, "v9.1.0", "bin", "tool")]);
    expect(versionedBins(root, "tool", 1)).toEqual([join(root, "v24.18.0", "bin", "tool")]);
    expect(versionedBins(join(d, "missing"), "tool")).toEqual([]);
    expect(versionedBins("relative/root", "tool")).toEqual([]);
    for (let i = 0; i < VERSIONED_BINS_MAX + 4; i++) mkdirSync(join(root, `v1.${i}.0`), { recursive: true });
    expect(versionedBins(root, "tool")).toHaveLength(VERSIONED_BINS_MAX);
  });

  it("reads the home only from the env it is given", () => {
    expect(homeOf({ HOME: "/Users/someone" })).toBe("/Users/someone");
    expect(homeOf({ HOME: "relative" })).toBeUndefined();
    expect(homeOf({})).toBeUndefined();
  });

  it("puts the CLI's own directory first on the child PATH, once", () => {
    const cli = "/Users/someone/.nvm/versions/node/v24.18.0/bin/codex";
    const dir = "/Users/someone/.nvm/versions/node/v24.18.0/bin";
    expect(pathWithCliDir(cli, "/usr/bin:/bin:/usr/sbin:/sbin")).toBe(`${dir}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(pathWithCliDir(cli, `${dir}:/usr/bin`)).toBe(`${dir}:/usr/bin`);
    // Elsewhere on PATH it still goes first: the CLI's own `node` wins over another one.
    expect(pathWithCliDir(cli, `/usr/bin:${dir}`)).toBe(`${dir}:/usr/bin:${dir}`);
    expect(pathWithCliDir(cli, undefined)).toBe(dir);
    expect(pathWithCliDir(cli, "")).toBe(dir);
  });

  it("withCliDirOnPath replaces only PATH, in a new frozen object", () => {
    const env = Object.freeze({ HOME: "/h", PATH: "/usr/bin" });
    const out = withCliDirOnPath(env, "/opt/tool/bin/claude");
    expect(out).toEqual({ HOME: "/h", PATH: "/opt/tool/bin:/usr/bin" });
    expect(Object.isFrozen(out)).toBe(true);
    expect(env.PATH).toBe("/usr/bin");
    expect(withCliDirOnPath({ HOME: "/h" }, "/opt/tool/bin/claude")).toEqual({ HOME: "/h", PATH: "/opt/tool/bin" });
  });
});
