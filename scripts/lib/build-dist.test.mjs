import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDist } from "./build-dist.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixturePackage() {
  const pkg = mkdtempSync(join(tmpdir(), "build-dist-"));
  dirs.push(pkg);
  mkdirSync(join(pkg, "src", "sub"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(pkg, "tsconfig.build.json"),
    JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src", outDir: "dist", declaration: true, sourceMap: true, types: [] }, include: ["src"] }),
  );
  writeFileSync(join(pkg, "src", "a.ts"), 'export const a: string = "one";\n');
  writeFileSync(join(pkg, "src", "sub", "b.ts"), 'import { a } from "../a.js";\nexport const b = a + "!";\n');
  return pkg;
}

const read = (p) => readFileSync(p, "utf8");

describe("buildDist", () => {
  it("emits what tsc would into dist/, source maps included, and removes its staging directory", () => {
    const pkg = fixturePackage();
    buildDist(pkg);
    expect(read(join(pkg, "dist", "a.js"))).toContain('export const a = "one";');
    expect(read(join(pkg, "dist", "sub", "b.d.ts"))).toContain("export declare const b");
    expect(JSON.parse(read(join(pkg, "dist", "sub", "b.js.map"))).sources).toEqual(["../../src/sub/b.ts"]);
    expect(readdirSync(pkg).sort()).toEqual(["dist", "package.json", "src", "tsconfig.build.json"]);
  });

  it("an unchanged build writes nothing, so a concurrent run's dist is never touched", () => {
    const pkg = fixturePackage();
    buildDist(pkg);
    const before = statSync(join(pkg, "dist", "a.js"), { bigint: true });
    expect(buildDist(pkg)).toEqual([]);
    const after = statSync(join(pkg, "dist", "a.js"), { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
  });

  it("a changed output replaces the file by rename: a reader of the old file still sees all of it", () => {
    const pkg = fixturePackage();
    buildDist(pkg);
    const target = join(pkg, "dist", "a.js");
    const old = read(target);
    const oldIno = statSync(target).ino;
    const fd = openSync(target, "r"); // a process that opened the module before the rebuild
    try {
      writeFileSync(join(pkg, "src", "a.ts"), 'export const a: string = "two";\n');
      expect(buildDist(pkg)).toEqual(["a.js"]); // the declaration and source map are unchanged
      const buf = Buffer.alloc(old.length + 16);
      expect(buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0))).toBe(old);
    } finally {
      closeSync(fd);
    }
    expect(statSync(target).ino).not.toBe(oldIno);
    expect(read(target)).toContain('export const a = "two";');
    expect(readdirSync(join(pkg, "dist")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("dist builds", () => {
  it("no test file rebuilds a package: only the global setups build, through buildDist", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.test\.(ts|mjs)$/.test(e.name) && /typescript\/package\.json|bin\/tsc|buildDist\(/.test(read(p)) && p !== fileURLToPath(import.meta.url)) offenders.push(relative(root, p));
      }
    };
    for (const d of ["packages", "scripts", "test"]) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});
