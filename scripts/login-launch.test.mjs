// setup --login-launch / uninstall / the LAUNCH_AGENTS_DIR override rules (P4.3), against a
// temp home and a fake bundled app. Nothing is loaded into launchd.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { appBinary, layout } from "./lib/paths.mjs";
import { infoPlist, launchAgentPlist, sha256 } from "./lib/app-bundle.mjs";
import { listTree, makeFixture } from "./lib/test-fixture.mjs";

let fx, env, L, agents;
beforeEach(() => {
  fx = makeFixture();
  agents = join(fx.root, "Launch Agents");
  env = { ...fx.env, LAUNCH_AGENTS_DIR: agents };
  L = layout({ env, scoutRoot: fx.scoutRoot });
});
afterEach(() => fx.cleanup());

function capture() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return { lines, out: push, err: push, text: () => lines.join("\n") };
}
const setup = (args = [], e = env, extra = {}) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env: e, out: c.out, err: c.err, claudeFallbacks: [], ...extra });
  return { code, ...c };
};
const uninstall = async (args = ["--yes"], e = env) => {
  const c = capture();
  const code = await runUninstall(args, { env: e, out: c.out, err: c.err, claudeFallbacks: [] });
  return { code, ...c };
};
function fakeBundle(app = L.appBundle) {
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), infoPlist({ version: "0.0.0" }));
  writeFileSync(appBinary(app), "#!/bin/sh\nexit 0\n");
  chmodSync(appBinary(app), 0o755);
  return app;
}

describe("setup --login-launch", () => {
  it("writes a RunAtLoad LaunchAgent for the bundled binary (absolute) and records it with its hash", () => {
    fakeBundle();
    const r = setup(["--login-launch"]);
    expect(r.code, r.text()).toBe(0);
    const text = readFileSync(L.launchAgent, "utf8");
    expect(text).toBe(launchAgentPlist({ program: appBinary(L.appBundle) }));
    expect(text).toContain(`<string>${appBinary(L.appBundle)}</string>`);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).not.toContain("KeepAlive");
    const lint = spawnSync("plutil", ["-lint", L.launchAgent], { encoding: "utf8" });
    if (!lint.error) expect(lint.status, lint.stdout).toBe(0);
    const entry = JSON.parse(readFileSync(L.installed, "utf8")).files.find((f) => f.kind === "launch-agent");
    expect(entry).toEqual({ path: L.launchAgent, kind: "launch-agent", sha256: sha256(text), program: appBinary(L.appBundle) });
    expect(r.text()).toMatch(/takes effect at your next login/);
    // Idempotent.
    expect(setup(["--login-launch"]).code).toBe(0);
    expect(JSON.parse(readFileSync(L.installed, "utf8")).files.filter((f) => f.kind === "launch-agent")).toHaveLength(1);
  });

  it("--app picks another bundle; --dry-run writes nothing", () => {
    const other = fakeBundle(join(fx.root, "Apps", "Scout.app"));
    const before = listTree(fx.root);
    const dry = setup(["--dry-run", "--login-launch", "--app", other]);
    expect(dry.code, dry.text()).toBe(0);
    expect(dry.text()).toContain(`would write ${L.launchAgent} (0644): RunAtLoad ${appBinary(other)}`);
    expect(listTree(fx.root)).toEqual(before);
    expect(setup(["--login-launch", "--app", other]).code).toBe(0);
    expect(readFileSync(L.launchAgent, "utf8")).toContain(appBinary(other));
  });

  it("refuses without a bundled app, and --app without --login-launch", () => {
    const r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/no bundled app at .*run `npm run bundle-app` first/);
    expect(existsSync(L.scoutHome)).toBe(false);
    expect(setup(["--app", "/x/Scout.app"]).text()).toMatch(/--app goes with --login-launch/);
  });

  it("a test home needs LAUNCH_AGENTS_DIR; the real ~/.scout refuses it", () => {
    fakeBundle();
    const r = setup(["--login-launch"], fx.env);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/needs LAUNCH_AGENTS_DIR/);
    const real = setup(["--login-launch"], env, { realHome: fx.home });
    expect(real.code).toBe(1);
    expect(real.text()).toMatch(/LAUNCH_AGENTS_DIR is for test installs only/);
    expect(existsSync(agents)).toBe(false);
  });

  it("refuses to overwrite a LaunchAgent it did not write, or one changed since", () => {
    fakeBundle();
    mkdirSync(agents);
    writeFileSync(L.launchAgent, "<plist>theirs</plist>");
    let r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/refusing to overwrite .*setup did not write it/);
    expect(readFileSync(L.launchAgent, "utf8")).toBe("<plist>theirs</plist>");

    writeFileSync(L.launchAgent, "");
    spawnSync("rm", [L.launchAgent]);
    expect(setup(["--login-launch"]).code).toBe(0);
    writeFileSync(L.launchAgent, readFileSync(L.launchAgent, "utf8") + "<!-- mine -->");
    r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/changed since setup wrote it/);
  });
});

describe("uninstall and the LaunchAgent", () => {
  it("removes it when unchanged", async () => {
    fakeBundle();
    expect(setup(["--login-launch"]).code).toBe(0);
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(0);
    expect(existsSync(L.launchAgent)).toBe(false);
    expect(r.text()).toMatch(/remove .*dev\.scout\.app\.plist \(unchanged since setup wrote it\)/);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("keeps a changed one, explains, keeps it recorded, and exits 2", async () => {
    fakeBundle();
    expect(setup(["--login-launch"]).code).toBe(0);
    writeFileSync(L.launchAgent, readFileSync(L.launchAgent, "utf8") + "<!-- mine -->");
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.launchAgent)).toBe(true);
    expect(r.text()).toMatch(/SKIP .*dev\.scout\.app\.plist \(changed since setup wrote it; not removing\)/);
    expect(JSON.parse(readFileSync(L.installed, "utf8")).files.map((f) => f.kind)).toEqual(["launch-agent"]);
  });

  it("ignores a tampered entry pointing elsewhere", async () => {
    fakeBundle();
    expect(setup(["--login-launch"]).code).toBe(0);
    const victim = join(fx.root, "victim.plist");
    writeFileSync(victim, "keep");
    const rec = JSON.parse(readFileSync(L.installed, "utf8"));
    rec.files = rec.files.map((f) => (f.kind === "launch-agent" ? { ...f, path: victim, sha256: sha256("keep") } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = await uninstall(["--yes"]);
    expect(r.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(r.text()).toMatch(/SKIP .*victim\.plist \(not a path setup writes for kind launch-agent/);
  });

  it("removes an unchanged agent profile but keeps an edited one", async () => {
    expect(setup().code).toBe(0);
    writeFileSync(L.agentProfile, readFileSync(L.agentProfile, "utf8").replace("claude-sonnet-5-5", "claude-opus-5-5"));
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.agentProfile)).toBe(true);
    expect(r.text()).toMatch(/SKIP .*agent-profile\.json \(changed since setup wrote it; not removing\)/);
  });
});
