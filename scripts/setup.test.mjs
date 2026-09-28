import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runChecks, runDoctor } from "./doctor.mjs";
import { layout } from "./lib/paths.mjs";
import { extensionIdFromManifestKey } from "./lib/extension-key.mjs";
import { FAKE_MANIFEST, listTree, makeFixture } from "./lib/test-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = (p) => statSync(p).mode & 0o777;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

function capture() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return { lines, out: push, err: push, text: () => lines.join("\n") };
}

let fx;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const setup = (args = [], env = fx.env) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env, out: c.out, err: c.err });
  return { code, ...c };
};

describe("setup --dry-run", () => {
  it("prints every path, including ones with spaces, and writes nothing (subprocess)", () => {
    const before = listTree(fx.root);
    // CHROME_NMH_DIR unset: the default location under the (temp) HOME, which has a space.
    const env = { ...fx.env, CHROME_NMH_DIR: undefined };
    const r = spawnSync(process.execPath, [join(HERE, "setup.mjs"), "--dry-run", "--scout-root", fx.scoutRoot], { env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    for (const p of [L.keyPem, L.extensionManifest, L.scoutConfig, L.pcConfig, L.wrapper, L.nmhManifest, L.installed]) expect(r.stdout).toContain(p);
    expect(r.stdout).toContain("Application Support/Google/Chrome/NativeMessagingHosts/dev.scout.bridge.json");
    expect(r.stdout).toMatch(/would write .*extension-key\.pem.*would generate/);
    expect(listTree(fx.root)).toEqual(before);
    expect(json(L.extensionManifest)).toEqual(FAKE_MANIFEST);
  });

  it("fails with a build hint when the extension is not built", () => {
    const c = capture();
    const code = runSetup(["--dry-run", "--scout-root", join(fx.root, "empty")], { env: fx.env, out: c.out, err: c.err });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/npm run build/);
  });
});

describe("setup", () => {
  it("writes every file with the right modes and records them", () => {
    const r = setup();
    expect(r.code, r.text()).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });

    expect(mode(L.scoutHome)).toBe(0o700);
    expect(mode(L.binDir)).toBe(0o700);
    expect(mode(L.pcHome)).toBe(0o700);
    expect(mode(L.keyPem)).toBe(0o600);
    expect(mode(L.scoutConfig)).toBe(0o600);
    expect(mode(L.pcConfig)).toBe(0o600);
    expect(mode(L.wrapper)).toBe(0o700);
    expect(mode(L.installed)).toBe(0o600);

    const installed = json(L.installed);
    const scout = json(L.scoutConfig);
    expect(scout).toEqual({
      x_scout_marker: installed.marker,
      nodePath: process.execPath,
      scoutRoot: fx.scoutRoot,
      extensionId: expect.stringMatching(/^[a-p]{32}$/),
      destinations: ["docs.stripe.com", "www.peakdesign.com"],
    });
    expect(json(L.pcConfig)).toEqual({ x_scout_marker: installed.marker, nodePath: process.execPath, claudePath: join(fx.binDir, "claude") });

    const ext = json(L.extensionManifest);
    expect(extensionIdFromManifestKey(ext.key)).toBe(scout.extensionId);
    expect({ ...ext, key: undefined }).toEqual({ ...FAKE_MANIFEST, key: undefined });

    expect(json(L.nmhManifest)).toEqual({
      name: "dev.scout.bridge",
      description: "Scout native bridge",
      path: L.wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${scout.extensionId}/`],
      x_scout_marker: installed.marker,
    });

    const wrapper = readFileSync(L.wrapper, "utf8");
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
    expect(wrapper).toContain(`# scout-marker: ${installed.marker}`);
    expect(wrapper).toContain(`exec "${process.execPath}" "${L.hostJs}" "$@"`);

    expect(installed.files.map((f) => [f.kind, f.path]).sort()).toEqual(
      [
        ["key", L.keyPem],
        ["extension-manifest-key", L.extensionManifest],
        ["config", L.scoutConfig],
        ["config", L.pcConfig],
        ["wrapper", L.wrapper],
        ["nmh-manifest", L.nmhManifest],
      ].sort(),
    );
  });

  it("the wrapper actually execs node on host.js with the origin argument", () => {
    writeFileSync(join(fx.scoutRoot, "packages/native-host/dist/host.js"), "console.log(JSON.stringify([process.argv[2], process.env.SCOUT_HOME]));\n");
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const r = spawnSync(L.wrapper, ["chrome-extension://x/"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["chrome-extension://x/", L.scoutHome]);
  });

  it("is idempotent: same key, same marker, no duplicate records, destinations preserved", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const first = json(L.installed);
    const pem = readFileSync(L.keyPem, "utf8");
    const cfg = json(L.scoutConfig);
    writeFileSync(L.scoutConfig, JSON.stringify({ ...cfg, destinations: ["example.com"] }));
    expect(setup().code).toBe(0);
    const second = json(L.installed);
    expect(second.marker).toBe(first.marker);
    expect(second.files).toHaveLength(6);
    expect(readFileSync(L.keyPem, "utf8")).toBe(pem);
    expect(json(L.scoutConfig).extensionId).toBe(cfg.extensionId);
    expect(json(L.scoutConfig).destinations).toEqual(["example.com"]);
    expect(mode(L.scoutConfig)).toBe(0o600);
  });

  it("writes claudePath null with a warning when claude is not found", () => {
    const r = setup([], { ...fx.env, PATH: join(fx.root, "no-bin") });
    // Fallbacks (~/.local/bin under the temp HOME, /opt/homebrew/bin) may still find one on this machine.
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const claudePath = json(L.pcConfig).claudePath;
    if (claudePath === null) expect(r.text()).toMatch(/claude not found/);
    else expect(claudePath).toBe("/opt/homebrew/bin/claude");
  });

  it("refuses to overwrite a native messaging manifest that is not its own", () => {
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    spawnSync("mkdir", ["-p", L.nmhDir]);
    writeFileSync(L.nmhManifest, JSON.stringify({ name: "dev.scout.bridge", path: "/elsewhere" }));
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/refusing to overwrite/);
    expect(existsSync(L.scoutHome)).toBe(false);
    expect(json(L.nmhManifest).path).toBe("/elsewhere");
  });
});

describe("uninstall", () => {
  const uninstall = (args = []) => {
    const c = capture();
    const code = runUninstall(args, { env: fx.env, out: c.out, err: c.err });
    return { code, ...c };
  };

  it("--dry-run changes nothing", () => {
    expect(setup().code).toBe(0);
    const before = listTree(fx.root);
    const r = uninstall(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(listTree(fx.root)).toEqual(before);
  });

  it("removes only listed files, strips the manifest key, keeps logs, unlisted files, and the key", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    spawnSync("mkdir", ["-p", L.logsDir]);
    writeFileSync(join(L.logsDir, "diagnostics.jsonl"), "{}\n");
    writeFileSync(join(L.scoutHome, "unlisted.txt"), "x");
    writeFileSync(join(L.nmhDir, "other.host.json"), "{}");

    const r = uninstall();
    expect(r.code, r.text()).toBe(0);
    for (const p of [L.scoutConfig, L.pcConfig, L.wrapper, L.nmhManifest]) expect(existsSync(p)).toBe(false);
    expect(existsSync(L.binDir)).toBe(false);
    expect(json(L.extensionManifest)).toEqual(FAKE_MANIFEST);
    expect(existsSync(join(L.logsDir, "diagnostics.jsonl"))).toBe(true);
    expect(existsSync(join(L.scoutHome, "unlisted.txt"))).toBe(true);
    expect(existsSync(join(L.nmhDir, "other.host.json"))).toBe(true);
    expect(existsSync(L.keyPem)).toBe(true);
    expect(json(L.installed).files.map((f) => f.kind)).toEqual(["key"]);
    expect(r.text()).toMatch(/--include-key/);

    const r2 = uninstall(["--include-key"]);
    expect(r2.code).toBe(0);
    expect(existsSync(L.keyPem)).toBe(false);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses a file whose marker was tampered and keeps it listed", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const nmh = json(L.nmhManifest);
    writeFileSync(L.nmhManifest, JSON.stringify({ ...nmh, x_scout_marker: "someone-else" }));
    const wrapper = readFileSync(L.wrapper, "utf8").replace(/# scout-marker: .*/, "# replaced");
    writeFileSync(L.wrapper, wrapper);

    const r = uninstall(["--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.nmhManifest)).toBe(true);
    expect(existsSync(L.wrapper)).toBe(true);
    expect(existsSync(L.scoutConfig)).toBe(false);
    expect(existsSync(L.keyPem)).toBe(false);
    expect(r.text()).toMatch(/SKIP .*dev\.scout\.bridge\.json/);
    expect(json(L.installed).files.map((f) => f.kind).sort()).toEqual(["nmh-manifest", "wrapper"]);
  });
});

describe("doctor", () => {
  it("reports all OK after a fresh setup", () => {
    expect(setup().code).toBe(0);
    const c = capture();
    const code = runDoctor(fx.env, c.out);
    expect(code, c.text()).toBe(0);
    expect(c.text()).not.toMatch(/^FAIL/m);
  });

  it("reports WARN, not FAIL, for a null claudePath", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    writeFileSync(L.pcConfig, JSON.stringify({ ...json(L.pcConfig), claudePath: null }));
    const results = runChecks(fx.env);
    expect(results.find((r) => r.label === "claudePath not set")?.status).toBe("WARN");
    expect(results.filter((r) => r.status === "FAIL")).toEqual([]);
  });

  it("reports FAIL when a path breaks or a mode drifts", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    writeFileSync(L.pcConfig, JSON.stringify({ ...json(L.pcConfig), claudePath: join(fx.root, "missing", "claude") }));
    chmodSync(L.wrapper, 0o755);
    chmodSync(L.keyPem, 0o644);
    const c = capture();
    expect(runDoctor(fx.env, c.out)).toBe(1);
    const failed = runChecks(fx.env).filter((r) => r.status === "FAIL").map((r) => r.label);
    expect(failed).toEqual(["claudePath is an executable file", "wrapper mode is 0700", "extension key is a 0600 file"]);
  });

  it("reports FAIL when nothing is installed and writes nothing", () => {
    const before = listTree(fx.root);
    const c = capture();
    expect(runDoctor(fx.env, c.out)).toBe(1);
    expect(listTree(fx.root)).toEqual(before);
  });
});
