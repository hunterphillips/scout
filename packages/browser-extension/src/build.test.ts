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
