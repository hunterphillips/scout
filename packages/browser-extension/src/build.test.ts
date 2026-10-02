import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs build helper without types
import { zodEnglishOnly } from "../zod-en-only.mjs";

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
    for (const f of ["panel.js", "content/github-issue.js"]) {
      expect(readFileSync(join(dist, f), "utf8")).not.toMatch(/new F\(|new Function|globalConfig\.jitless/);
    }
  } finally {
    rmSync(join(dist, ".."), { recursive: true, force: true });
  }
}, 30_000);

it("dist holds exactly the background, the side panel and the GitHub content script; no popup", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "scout-ext-")), "dist");
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, ["build.mjs"], { cwd: root, env: { ...process.env, SCOUT_EXT_DIST: dist }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const files = (readdirSync(dist, { recursive: true }) as string[]).filter((f) => !statSync(join(dist, f)).isDirectory()).sort();
    expect(files).toEqual(["background.js", "content/github-issue.js", "manifest.json", "panel.html", "panel.js"].map((f) => f.split("/").join(sep)));
    const html = readFileSync(join(dist, "panel.html"), "utf8");
    expect(html).toContain('<script type="module" src="panel.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*src="panel\.js")/); // MV3 CSP: no inline script
    const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(m["side_panel"]).toEqual({ default_path: "panel.html" });
    expect(m["action"]).not.toHaveProperty("default_popup");
  } finally {
    rmSync(join(dist, ".."), { recursive: true, force: true });
  }
}, 30_000);

it("the manifest asks for exact sites one at a time: https://*/* is optional only, the permission set is exact, and there is no tabs permission", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
  expect(m["optional_host_permissions"]).toEqual(["https://*/*"]);
  expect(m["host_permissions"]).toBeUndefined();
  expect([...(m["permissions"] as string[])].sort()).toEqual(["activeTab", "nativeMessaging", "scripting", "sidePanel", "storage"]);
  expect(m["minimum_chrome_version"]).toBe("116");
  expect(m["side_panel"]).toEqual({ default_path: "panel.html" });
  expect(m["action"]).toEqual({ default_title: "Scout" });
  expect(m["optional_permissions"]).toBeUndefined();
  expect(m["content_scripts"]).toBeUndefined(); // registered at runtime, only with the GitHub grant and toggle
  expect(m["incognito"]).toBe("not_allowed");
});

it("the worker bundles zod without its non-English locales (~820 KB -> ~456 KB) and stays under 500 KB", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "scout-ext-")), "dist");
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, ["build.mjs"], { cwd: root, env: { ...process.env, SCOUT_EXT_DIST: dist }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const bg = readFileSync(join(dist, "background.js"), "utf8");
    expect(Buffer.byteLength(bg)).toBeLessThan(500 * 1024);
    expect(bg).toContain("Invalid input: expected ");
    expect(bg).not.toMatch(/node_modules\/zod\/v4\/locales\/(?!en\.js)[\w-]+\.js/);
    expect(bg).not.toContain("non optionnel"); // French
  } finally {
    rmSync(join(dist, ".."), { recursive: true, force: true });
  }
}, 30_000);

it("with English only, the contracts' schemas still validate and report in English, jitless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-ext-zod-"));
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const out = join(dir, "probe.mjs");
    await build({
      stdin: {
        contents: `import "./src/zod-jitless.ts";
import { CommandFrameSchema, ToChromeFrameSchema } from "@scout/contracts";
import { z } from "zod";
export { CommandFrameSchema, ToChromeFrameSchema, z };`,
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      outfile: out,
      logLevel: "silent",
      plugins: [zodEnglishOnly],
    });
    const probe = (await import(out)) as {
      ToChromeFrameSchema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } };
      CommandFrameSchema: { safeParse(v: unknown): { success: boolean } };
      z: { locales: Record<string, unknown>; globalConfig?: unknown };
    };
    const fixture = JSON.parse(readFileSync(join(root, "..", "contracts", "fixtures", "bridge", "to-chrome.capture-policy.json"), "utf8"));
    expect(probe.ToChromeFrameSchema.safeParse(fixture).success).toBe(true);
    const bad = probe.ToChromeFrameSchema.safeParse({ ...fixture, revision: "x" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.some((i) => /^Invalid input/.test(i.message))).toBe(true);
    const bridge = (name: string) => JSON.parse(readFileSync(join(root, "..", "contracts", "fixtures", "bridge", name), "utf8"));
    expect(probe.CommandFrameSchema.safeParse(bridge("to-core.command.open-link.json")).success).toBe(true);
    expect(probe.CommandFrameSchema.safeParse(bridge("refused.command.shutdown.json")).success).toBe(false);
    expect(Object.keys(probe.z.locales)).toEqual(["en"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
