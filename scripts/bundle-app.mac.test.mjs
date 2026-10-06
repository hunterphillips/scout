// npm run bundle-app (P4.3). The default suite bundles a stand-in executable (--binary) so it
// needs no Swift build; SCOUT_BUNDLE_SWIFT=1 adds the real `swift build -c release` run.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBundle } from "./bundle-app.mjs";
import { listTree } from "./lib/test-fixture.mjs";
import { bundleHash, infoPlist } from "./lib/app-bundle.mjs";

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

    // dev.scout.app appears in the plist, but not as its CFBundleIdentifier.
    const lookalike = infoPlist({ version: "0.0.0" }).replace("<string>dev.scout.app</string>", "<string>com.example.other</string>").replace("<string>Scout</string>", "<string>dev.scout.app</string>");
    writeFileSync(join(foreign, "Info.plist"), lookalike);
    const c3 = capture();
    expect(runBundle(["--out", out, "--binary", standIn()], c3)).toBe(1);
    expect(c3.text()).toMatch(/its CFBundleIdentifier is not dev\.scout\.app/);
    expect(readFileSync(join(foreign, "Info.plist"), "utf8")).toBe(lookalike);

    const plain = join(root, "plain");
    writeFileSync(plain, "x");
    const c2 = capture();
    expect(runBundle(["--out", join(root, "o2"), "--binary", plain], c2)).toBe(1);
    expect(c2.text()).toMatch(/not an executable file/);
  });
});

describe("bundleHash", () => {
  function bundle() {
    const app = join(root, "Scout.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), infoPlist({ version: "0.0.0" }));
    writeFileSync(join(app, "Contents", "MacOS", "Scout"), "#!/bin/sh\nexit 0\n");
    return app;
  }

  it("changes when a file is added or edited, not when _CodeSignature/ changes", () => {
    const app = bundle();
    const base = bundleHash(app);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    mkdirSync(join(app, "Contents", "_CodeSignature"));
    writeFileSync(join(app, "Contents", "_CodeSignature", "CodeResources"), "one");
    expect(bundleHash(app)).toBe(base);
    writeFileSync(join(app, "Contents", "_CodeSignature", "CodeResources"), "two");
    expect(bundleHash(app)).toBe(base);
    writeFileSync(join(app, "Contents", "extra.txt"), "x");
    expect(bundleHash(app)).not.toBe(base);
    rmSync(join(app, "Contents", "extra.txt"));
    expect(bundleHash(app)).toBe(base);
    writeFileSync(join(app, "Contents", "MacOS", "Scout"), "#!/bin/sh\nexit 1\n");
    expect(bundleHash(app)).not.toBe(base);
  });

  it("hashes a symlink's target string, not the content it points to", () => {
    const app = bundle();
    const target = join(root, "outside.txt");
    writeFileSync(target, "a");
    symlinkSync(target, join(app, "Contents", "link"));
    const linked = bundleHash(app);
    writeFileSync(target, "b");
    expect(bundleHash(app)).toBe(linked);
    rmSync(join(app, "Contents", "link"));
    symlinkSync(join(root, "elsewhere"), join(app, "Contents", "link"));
    expect(bundleHash(app)).not.toBe(linked);
  });

  it("is null for a missing bundle or a symlink to one", () => {
    expect(bundleHash(join(root, "nope.app"))).toBeNull();
    const app = bundle();
    symlinkSync(app, join(root, "Alias.app"));
    expect(bundleHash(join(root, "Alias.app"))).toBeNull();
  });
});

describe.skipIf(!HAS_SWIFT || !process.env.SCOUT_BUNDLE_SWIFT)("bundle-app with the real Swift build (opt-in: SCOUT_BUNDLE_SWIFT=1 and swift on PATH)", () => {
  it("builds the real app with swift build -c release", () => {
    const c = capture();
    expect(runBundle(["--out", out], c), c.text()).toBe(0);
    checkBundle(join(out, "Scout.app"));
  }, 600_000);
});
