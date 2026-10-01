import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("a rebuild keeps the key that setup wrote into dist/manifest.json", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "scout-ext-")), "dist");
  try {
    mkdirSync(dist);
    writeFileSync(join(dist, "manifest.json"), JSON.stringify({ key: "TEST-KEY" }));
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, ["build.mjs"], { cwd: root, env: { ...process.env, SCOUT_EXT_DIST: dist }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as { key?: string; name?: string };
    expect(m).toMatchObject({ key: "TEST-KEY", name: "Scout Sensor" });
  } finally {
    rmSync(join(dist, ".."), { recursive: true, force: true });
  }
}, 30_000);

it("the service worker turns zod jitless before any Scout module runs; other bundles carry no zod", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "scout-ext-")), "dist");
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, ["build.mjs"], { cwd: root, env: { ...process.env, SCOUT_EXT_DIST: dist }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const bg = readFileSync(join(dist, "background.js"), "utf8");
    const jitless = bg.search(/\.config\(\{ jitless: true \}\)/);
    const firstScoutModule = bg.search(/^\/\/ (src\/(?!zod-jitless)|\.\.\/contracts\/)/m);
    expect(jitless).toBeGreaterThan(-1);
    expect(jitless).toBeLessThan(firstScoutModule);
    // zod's eval probe is still bundled, but it returns early once jitless is set.
    expect(bg).toMatch(/allowsEval = [^]*?if \(globalConfig\.jitless\) \{\s*return false;/);
    for (const f of ["popup.js", "content/github-issue.js"]) {
      expect(readFileSync(join(dist, f), "utf8")).not.toMatch(/new F\(|new Function/);
    }
  } finally {
    rmSync(join(dist, ".."), { recursive: true, force: true });
  }
}, 30_000);

it("the manifest asks for exact sites one at a time: https://*/* is optional only, activeTab is required, and there is no tabs permission", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
  expect(m["optional_host_permissions"]).toEqual(["https://*/*"]);
  expect(m["host_permissions"]).toBeUndefined();
  expect(m["permissions"]).toEqual(expect.arrayContaining(["activeTab", "nativeMessaging", "scripting", "storage"]));
  expect(m["permissions"]).not.toContain("tabs");
  expect(m["optional_permissions"]).toBeUndefined();
  expect(m["content_scripts"]).toBeUndefined(); // registered at runtime, only with the GitHub grant and toggle
  expect(m["incognito"]).toBe("not_allowed");
});
