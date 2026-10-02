// npm run bundle-app (P4.3). The default suite bundles a stand-in executable (--binary) so it
// needs no Swift build; SCOUT_BUNDLE_SWIFT=1 adds the real `swift build -c release` run.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBundle } from "./bundle-app.mjs";
import { listTree } from "./lib/test-fixture.mjs";

const has = (cmd) => !spawnSync(cmd, ["--help"], { stdio: "ignore" }).error;
const HAS_SWIFT = !spawnSync("swift", ["--version"], { stdio: "ignore" }).error;

let root, out;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scout-bundle-")));
  out = join(root, "out dir");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function capture() {
  const lines = [];
  return { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)), text: () => lines.join("\n") };
}
function standIn() {
  const bin = join(root, "ScoutApp");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}
function checkBundle(app) {
  const plist = join(app, "Contents", "Info.plist");
  if (has("plutil")) expect(spawnSync("plutil", ["-lint", plist], { encoding: "utf8" }).status).toBe(0);
  const text = readFileSync(plist, "utf8");
  expect(text).toMatch(/<key>CFBundleIdentifier<\/key>\s*<string>dev\.scout\.app<\/string>/);
  expect(text).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
  expect(text).toMatch(/<key>NSHighResolutionCapable<\/key>\s*<true\/>/);
  expect(text).toMatch(/<key>CFBundleVersion<\/key>\s*<string>\d+\.\d+\.\d+<\/string>/);
  expect(text).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>Scout<\/string>/);
  expect(statSync(join(app, "Contents", "MacOS", "Scout")).mode & 0o111).toBe(0o111);
  if (has("codesign")) expect(spawnSync("codesign", ["--verify", "--deep", "--strict", app]).status).toBe(0);
}

describe("bundle-app", () => {
  it("--dry-run lists the plist and the binary and writes nothing", () => {
    const before = listTree(root);
    const c = capture();
    expect(runBundle(["--dry-run", "--out", out], c)).toBe(0);
    expect(c.text()).toContain(`would write ${join(out, "Scout.app", "Contents", "MacOS", "Scout")} (0755)`);
    expect(c.text()).toContain(`would write ${join(out, "Scout.app", "Contents", "Info.plist")}:`);
    expect(c.text()).toContain("<string>dev.scout.app</string>");
    expect(c.text()).toMatch(/would run: swift build -c release --product ScoutApp/);
    expect(c.text()).toMatch(/codesign --force --deep -s -/);
    expect(listTree(root)).toEqual(before);
  });

  it("assembles, signs and replaces its own bundle, writing only under --out", () => {
    const bin = standIn();
    const c = capture();
    expect(runBundle(["--out", out, "--binary", bin], c), c.text()).toBe(0);
    const app = join(out, "Scout.app");
    checkBundle(app);
    expect(listTree(root).filter((f) => !f.startsWith("out dir/")).sort()).toEqual(["ScoutApp"]);
    expect(listTree(out).every((f) => f.startsWith("Scout.app/Contents/"))).toBe(true);
    // A rebuild replaces it.
    expect(runBundle(["--out", out, "--binary", bin], capture())).toBe(0);
    checkBundle(app);
  });

  it("refuses to replace a Scout.app it did not make, or a non-executable binary", () => {
    const foreign = join(out, "Scout.app", "Contents");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "Info.plist"), "<plist>someone else</plist>");
    const c = capture();
    expect(runBundle(["--out", out, "--binary", standIn()], c)).toBe(1);
    expect(c.text()).toMatch(/is not a Scout bundle/);
    expect(readFileSync(join(foreign, "Info.plist"), "utf8")).toBe("<plist>someone else</plist>");

    const plain = join(root, "plain");
    writeFileSync(plain, "x");
    const c2 = capture();
    expect(runBundle(["--out", join(root, "o2"), "--binary", plain], c2)).toBe(1);
    expect(c2.text()).toMatch(/not an executable file/);
  });

  it.skipIf(!HAS_SWIFT || !process.env.SCOUT_BUNDLE_SWIFT)("builds the real app with swift (SCOUT_BUNDLE_SWIFT=1)", () => {
    const c = capture();
    expect(runBundle(["--out", out], c), c.text()).toBe(0);
    checkBundle(join(out, "Scout.app"));
  }, 600_000);
});
