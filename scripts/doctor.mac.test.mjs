// doctor's Mac app section against a temp home: macOS only, since doctor reads the bundle's
// CFBundleIdentifier with `plutil`. The other sections are in doctor.test.mjs.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runReport } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { infoPlist } from "./lib/app-bundle.mjs";
import { makeFixture } from "./lib/test-fixture.mjs";

let fx, L, env;
beforeEach(() => {
  fx = makeFixture({ spaces: false });
  writeFileSync(join(fx.binDir, "claude"), `#!/bin/sh\necho "2.1.286 (Claude Code)"\n`);
  env = fx.env;
  L = layout({ env, scoutRoot: fx.scoutRoot });
  expect(runSetup(["--scout-root", fx.scoutRoot], { env, out: () => {}, err: () => {}, claudeFallbacks: [] })).toBe(0);
});
afterEach(() => fx.cleanup());

const report = (e = env) => Object.fromEntries(runReport(e, { claudeFallbacks: [] }).map((s) => [s.title, s]));

function fakeBundle(app) {
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), infoPlist({ version: "0.0.0" }));
  writeFileSync(join(app, "Contents", "MacOS", "Scout"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", "Scout"), 0o755);
}

describe("doctor report", () => {
  it("Mac app: warns when the app is not installed, notes a build, and reports a foreign LaunchAgent", () => {
    expect(report()["Mac app"]).toMatchObject({ status: "warn", summary: "not installed; login launch off" });
    fakeBundle(L.appBundle);
    expect(report()["Mac app"]).toMatchObject({ status: "warn", summary: `built at ${L.appBundle}, not installed; login launch off` });
    const foreignDir = join(fx.root, "OtherAgents");
    mkdirSync(foreignDir);
    writeFileSync(join(foreignDir, "dev.scout.app.plist"), "<plist/>");
    const r = report({ ...env, LAUNCH_AGENTS_DIR: foreignDir })["Mac app"];
    expect(r.checks.find((c) => c.label === "login LaunchAgent")).toMatchObject({ status: "WARN", detail: expect.stringMatching(/setup did not write it/) });
  });
});
