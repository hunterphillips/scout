import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runChecks, runDoctor } from "./doctor.mjs";
import { REPO_ROOT, layout } from "./lib/paths.mjs";
import { extensionIdFromManifestKey } from "./lib/extension-key.mjs";
import { FAKE_MANIFEST, listTree, makeFixture } from "./lib/test-fixture.mjs";
import { shDoubleQuote } from "./lib/files.mjs";

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

const setup = (args = [], env = fx.env, extra = {}) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env, out: c.out, err: c.err, ...extra });
  return { code, ...c };
};

describe("setup --dry-run", () => {
  it("prints every path, including ones with spaces, and writes nothing (subprocess)", () => {
    const before = listTree(fx.root);
    const env = fx.env;
    const r = spawnSync(process.execPath, [join(HERE, "setup.mjs"), "--dry-run", "--scout-root", fx.scoutRoot], { env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    for (const p of [L.keyPem, L.extensionManifest, L.scoutConfig, L.agentProfile, L.wrapper, L.nmhManifest, L.installed]) expect(r.stdout).toContain(p);
    expect(r.stdout).toContain("Application Support/Google/Chrome/NativeMessagingHosts/dev.scout.bridge.json");
    expect(r.stdout).toMatch(/would write .*extension-key\.pem.*would generate/);
    expect(listTree(fx.root)).toEqual(before);
    expect(json(L.extensionManifest)).toEqual(FAKE_MANIFEST);
  });

  it("fails the private-dir checks the same way a real run does", () => {
    const target = join(fx.root, "real scout home");
    mkdirSync(target);
    symlinkSync(target, fx.env.SCOUT_HOME);
    for (const args of [["--dry-run"], []]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toContain(`setup: ${fx.env.SCOUT_HOME} is not a directory`);
    }
  });

  it("says it would chmod an existing dir, and quotes the wrapper line for the shell", () => {
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    mkdirSync(L.scoutHome, { mode: 0o755 });
    chmodSync(L.scoutHome, 0o755);
    const r = setup(["--dry-run"]);
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toContain(`would chmod existing dir ${L.scoutHome} to 0700 (now 0755)`);
    expect(r.text()).toContain(`would create dir ${L.binDir} (0700)`);
    expect(r.text()).toContain(`exec ${shDoubleQuote(process.execPath)} ${shDoubleQuote(L.hostJs)} "$@"`);
    expect(mode(L.scoutHome)).toBe(0o755);
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
    expect(mode(L.keyPem)).toBe(0o600);
    expect(mode(L.scoutConfig)).toBe(0o600);
    expect(mode(L.agentProfile)).toBe(0o600);
    expect(mode(L.wrapper)).toBe(0o700);
    expect(mode(L.installed)).toBe(0o600);

    const installed = json(L.installed);
    const scout = json(L.scoutConfig);
    expect(scout).toEqual({
      x_scout_marker: installed.marker,
      nodePath: process.execPath,
      scoutRoot: fx.scoutRoot,
      extensionId: expect.stringMatching(/^[a-p]{32}$/),
      destinations: [],
    });
    expect(json(L.agentProfile)).toEqual({ schemaVersion: 1, adapter: "claude-code", model: "claude-sonnet-5-5", claudePath: join(fx.binDir, "claude") });

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
        ["agent-profile", L.agentProfile],
        ["wrapper", L.wrapper],
        ["nmh-manifest", L.nmhManifest],
      ].sort(),
    );
    expect(r.text()).toContain("Load the unpacked extension");
    expect(r.text()).toContain("opens Scout's side panel");
  });

  it("writes an agent profile the core accepts, only when none exists, and keeps a user's", async () => {
    const { loadAgentProfile } = await import("../packages/scout-core/dist/agents/profile.js");
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    expect(loadAgentProfile(L.scoutHome)).toMatchObject({ claudePath: join(fx.binDir, "claude"), model: "claude-sonnet-5-5" });
    // A re-run keeps it and its record.
    const first = json(L.installed).files.find((f) => f.kind === "agent-profile");
    expect(setup().code).toBe(0);
    expect(json(L.installed).files.find((f) => f.kind === "agent-profile")).toEqual(first);
    // An edited profile is the user's: kept, never rewritten.
    const edited = { ...json(L.agentProfile), model: "claude-opus-5-5" };
    writeFileSync(L.agentProfile, JSON.stringify(edited));
    const r = setup();
    expect(r.code, r.text()).toBe(0);
    expect(r.text()).toMatch(/kept .*agent-profile\.json as it is \(changed since setup wrote it\)/);
    expect(json(L.agentProfile)).toEqual(edited);
  });

  it("the wrapper actually execs node on host.js with the origin argument", () => {
    writeFileSync(join(fx.scoutRoot, "packages/native-host/dist/host.js"), "console.log(JSON.stringify([process.argv[2], process.env.SCOUT_HOME]));\n");
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const r = spawnSync(L.wrapper, ["chrome-extension://x/"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["chrome-extension://x/", L.scoutHome]);
  });

  it("the wrapper runs end to end when paths contain a double quote, a dollar sign, and a backtick", () => {
    fx.cleanup();
    fx = makeFixture({ rootPrefix: 'scout "q" $HOME `id` ' });
    writeFileSync(join(fx.scoutRoot, "packages/native-host/dist/host.js"), "console.log(JSON.stringify([process.argv[2], process.env.SCOUT_HOME]));\n");
    const r0 = setup();
    expect(r0.code, r0.text()).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    expect(L.hostJs).toMatch(/"q" \$HOME `id`/);
    const r = spawnSync(L.wrapper, ["chrome-extension://x/"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["chrome-extension://x/", L.scoutHome]);
    const c = capture();
    expect(runDoctor(fx.env, c.out), c.text()).toBe(0);
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
    expect(second.files).toHaveLength(6); // key, manifest key, config, agent profile, wrapper, nmh manifest
    expect(readFileSync(L.keyPem, "utf8")).toBe(pem);
    expect(json(L.scoutConfig).extensionId).toBe(cfg.extensionId);
    expect(json(L.scoutConfig).destinations).toEqual(["example.com"]);
    expect(mode(L.scoutConfig)).toBe(0o600);
  });

  it("records SCOUT_CLAUDE_BIN in the agent profile, never a different claude on PATH", () => {
    const other = join(fx.root, "other-bin");
    mkdirSync(other);
    writeFileSync(join(other, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(other, "claude"), 0o755);
    const r = setup([], { ...fx.env, PATH: other });
    expect(r.code, r.text()).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    expect(json(L.agentProfile).claudePath).toBe(fx.env.SCOUT_CLAUDE_BIN);
  });

  it("on a test home without SCOUT_CLAUDE_BIN writes no agent profile, with a warning, even with claude on PATH", () => {
    const r = setup([], { ...fx.env, SCOUT_CLAUDE_BIN: undefined });
    expect(r.code, r.text()).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    expect(existsSync(L.agentProfile)).toBe(false);
    expect(json(L.installed).files.some((f) => f.kind === "agent-profile")).toBe(false);
    expect(r.text()).toMatch(/no agent profile is written \(the Scout home is not the real ~\/\.scout, so SCOUT_CLAUDE_BIN must name the claude to run\)/);
  });

  it("CHROME_NMH_DIR is required with a test home and refused with the real one", () => {
    let r = setup([], { ...fx.env, CHROME_NMH_DIR: undefined });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/so CHROME_NMH_DIR must name a test location/);
    r = setup([], { ...fx.env, SCOUT_CLAUDE_BIN: undefined }, { realHome: fx.home });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/CHROME_NMH_DIR is for test installs only and refused with the real ~\/\.scout/);
    expect(existsSync(layout({ env: fx.env }).scoutHome)).toBe(false);
  });

  it("records the kinds present, and keeps version 1", () => {
    expect(setup().code).toBe(0);
    const rec = json(layout({ env: fx.env, scoutRoot: fx.scoutRoot }).installed);
    expect(rec.version).toBe(1);
    expect(rec.kinds).toEqual(["agent-profile", "config", "extension-manifest-key", "key", "nmh-manifest", "wrapper"]);
  });

  it("warns that a SCOUT_HOME install is for testing", () => {
    const r = setup(["--dry-run"]);
    expect(r.text()).toMatch(/warning: SCOUT_HOME is set .*native app only reads ~\/\.scout/);
  });

  it("rejects --yes", () => {
    const r = setup(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/unknown argument: --yes/);
  });

  it.each([
    ["config", (L) => [L.scoutConfig, JSON.stringify({ x_scout_marker: "other-install" })]],
    ["wrapper", (L) => [L.wrapper, "#!/bin/sh\n# scout-marker: other-install\n"]],
  ])("refuses to overwrite a %s left by a different marker", (_kind, make) => {
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const [p, text] = make(L);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    const r = setup();
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/refusing to overwrite/);
    expect(r.text()).toContain(p);
    expect(readFileSync(p, "utf8")).toBe(text);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses a non-default Scout home (SCOUT_HOME or HOME) without --scout-root, so the real extension is not re-keyed", () => {
    const real = join(REPO_ROOT, "packages/browser-extension/dist/manifest.json");
    const before = existsSync(real) ? readFileSync(real, "utf8") : null;
    const treeBefore = listTree(fx.root);
    // SCOUT_HOME set, and SCOUT_HOME unset with HOME pointed at a temp dir.
    for (const env of [fx.env, { ...fx.env, SCOUT_HOME: undefined }]) {
      for (const args of [[], ["--dry-run"]]) {
        const c = capture();
        expect(runSetup(args, { env, out: c.out, err: c.err })).toBe(1);
        expect(c.text()).toMatch(/is not the real ~\/\.scout and --scout-root is not given/);
        expect(c.text()).not.toMatch(/would write/);
      }
    }
    // The CLI with HOME overridden for the whole process (os.homedir() then follows it).
    const r = spawnSync(process.execPath, [join(HERE, "setup.mjs"), "--dry-run"], { env: { ...fx.env, SCOUT_HOME: undefined }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not the real ~\/\.scout and --scout-root is not given/);
    expect(r.stdout).not.toMatch(/would write/);
    expect(existsSync(real) ? readFileSync(real, "utf8") : null).toBe(before);
    expect(listTree(fx.root)).toEqual(treeBefore);
  });

  it("reports a failure after planning, and a re-run recovers (crash mid-setup)", () => {
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    mkdirSync(L.nmhDir, { recursive: true });
    chmodSync(L.nmhDir, 0o500);
    let r;
    try {
      r = setup();
    } finally {
      chmodSync(L.nmhDir, 0o755);
    }
    expect(r.code).toBe(1);
    expect(r.text()).toContain(`setup: failed at ${L.nmhManifest}`);
    expect(r.text()).toMatch(/re-running is safe/);
    expect(existsSync(L.nmhManifest)).toBe(false);
    const partial = json(L.installed);
    expect(partial.files.map((f) => f.kind)).toEqual(["key", "extension-manifest-key", "config", "agent-profile", "wrapper"]);
    const pem = readFileSync(L.keyPem, "utf8");

    // A stale temp file from the crashed run must not block the re-run.
    writeFileSync(join(L.nmhDir, `.dev.scout.bridge.json.${process.pid}.tmp`), "stale");
    const r2 = setup();
    expect(r2.code, r2.text()).toBe(0);
    expect(json(L.installed).marker).toBe(partial.marker);
    expect(json(L.installed).files).toHaveLength(6);
    expect(readFileSync(L.keyPem, "utf8")).toBe(pem);
    expect(existsSync(join(L.nmhDir, `.dev.scout.bridge.json.${process.pid}.tmp`))).toBe(false);
    const c = capture();
    expect(runDoctor(fx.env, c.out), c.text()).toBe(0);
  });

  it("reuses an existing key but forces it to 0600, and refuses a symlinked key", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    chmodSync(L.keyPem, 0o644);
    const dry = setup(["--dry-run"]);
    expect(dry.text()).toMatch(/would keep .*extension-key\.pem.*would chmod from 0644 to 0600/);
    expect(mode(L.keyPem)).toBe(0o644);
    expect(setup().code).toBe(0);
    expect(mode(L.keyPem)).toBe(0o600);

    const elsewhere = join(fx.root, "elsewhere.pem");
    writeFileSync(elsewhere, readFileSync(L.keyPem, "utf8"));
    spawnSync("rm", [L.keyPem]);
    symlinkSync(elsewhere, L.keyPem);
    for (const args of [[], ["--dry-run"]]) {
      const r = setup(args);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/extension-key\.pem is not a regular file/);
    }
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
  const uninstall = async (args = ["--yes"], confirm) => {
    const c = capture();
    const code = await runUninstall(args, { env: fx.env, out: c.out, err: c.err, confirm });
    return { code, ...c };
  };

  it("--dry-run changes nothing", async () => {
    expect(setup().code).toBe(0);
    const before = listTree(fx.root);
    const r = await uninstall(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(listTree(fx.root)).toEqual(before);
  });

  it("removes only listed files, strips the manifest key, keeps logs, unlisted files, and the key", async () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    spawnSync("mkdir", ["-p", L.logsDir]);
    writeFileSync(join(L.logsDir, "diagnostics.jsonl"), "{}\n");
    writeFileSync(join(L.scoutHome, "unlisted.txt"), "x");
    writeFileSync(join(L.nmhDir, "other.host.json"), "{}");

    const r = await uninstall();
    expect(r.code, r.text()).toBe(0);
    for (const p of [L.scoutConfig, L.agentProfile, L.wrapper, L.nmhManifest]) expect(existsSync(p)).toBe(false);
    expect(existsSync(L.binDir)).toBe(false);
    expect(json(L.extensionManifest)).toEqual(FAKE_MANIFEST);
    expect(existsSync(join(L.logsDir, "diagnostics.jsonl"))).toBe(true);
    expect(existsSync(join(L.scoutHome, "unlisted.txt"))).toBe(true);
    expect(existsSync(join(L.nmhDir, "other.host.json"))).toBe(true);
    expect(existsSync(L.keyPem)).toBe(true);
    expect(json(L.installed).files.map((f) => f.kind)).toEqual(["key"]);
    expect(r.text()).toMatch(/--include-key/);

    const r2 = await uninstall(["--yes", "--include-key"]);
    expect(r2.code).toBe(0);
    expect(existsSync(L.keyPem)).toBe(false);
    expect(existsSync(L.installed)).toBe(false);
  });

  it("refuses a file whose marker was tampered and keeps it listed", async () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const nmh = json(L.nmhManifest);
    writeFileSync(L.nmhManifest, JSON.stringify({ ...nmh, x_scout_marker: "someone-else" }));
    const wrapper = readFileSync(L.wrapper, "utf8").replace(/# scout-marker: .*/, "# replaced");
    writeFileSync(L.wrapper, wrapper);

    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.nmhManifest)).toBe(true);
    expect(existsSync(L.wrapper)).toBe(true);
    expect(existsSync(L.scoutConfig)).toBe(false);
    expect(existsSync(L.keyPem)).toBe(false);
    expect(r.text()).toMatch(/SKIP .*dev\.scout\.bridge\.json/);
    expect(json(L.installed).files.map((f) => f.kind).sort()).toEqual(["nmh-manifest", "wrapper"]);
  });
});

describe("uninstall: out-of-scope entries", () => {
  it("touches nothing outside what setup writes, reports an unknown kind (config-merged) and skips it, and exits 2", async () => {
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const marker = "m".repeat(32);
    const victimConfig = join(fx.root, "victim", "config.json");
    const victimUnknown = join(fx.root, "victim", "settings.json");
    mkdirSync(dirname(victimConfig), { recursive: true });
    writeFileSync(victimConfig, JSON.stringify({ x_scout_marker: marker }));
    writeFileSync(victimUnknown, JSON.stringify({ x_scout_marker: marker, nodePath: "/n", keep: 1 }));
    mkdirSync(L.scoutHome, { recursive: true, mode: 0o700 });
    const record = {
      version: 1,
      marker,
      files: [
        { path: victimConfig, kind: "config" },
        { path: victimUnknown, kind: "config-merged", keys: ["keep"] },
      ],
    };
    writeFileSync(L.installed, JSON.stringify(record));
    const before = listTree(fx.root).map((f) => [f, readFileSync(join(fx.root, f), "utf8")]);

    const c = capture();
    const code = await runUninstall(["--yes"], { env: fx.env, out: c.out, err: c.err });
    expect(code).toBe(2);
    expect(c.text()).toMatch(/SKIP .*victim\/config\.json \(not a path setup writes for kind config/);
    expect(c.text()).toMatch(/SKIP .*victim\/settings\.json \(not a path setup writes for kind config-merged; not touching\)/);
    expect(json(L.installed).files).toHaveLength(2);
    expect(listTree(fx.root).map((f) => [f, readFileSync(join(fx.root, f), "utf8")])).toEqual(before);

    const bad = runChecks(fx.env).find((r) => r.label === "install record lists only paths setup writes");
    expect(bad.status).toBe("FAIL");
  });
});

describe("uninstall confirmation", () => {
  it("aborts without changes when the prompt is declined", async () => {
    expect(setup().code).toBe(0);
    const before = listTree(fx.root);
    const c = capture();
    const code = await runUninstall([], { env: fx.env, out: c.out, err: c.err, confirm: async () => false });
    expect(code).toBe(1);
    expect(c.text()).toMatch(/Aborted/);
    expect(listTree(fx.root)).toEqual(before);
  });

  it("proceeds when the prompt is accepted", async () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const c = capture();
    const code = await runUninstall([], { env: fx.env, out: c.out, err: c.err, confirm: async () => true });
    expect(code, c.text()).toBe(0);
    expect(existsSync(L.wrapper)).toBe(false);
  });

  it("aborts without hanging when stdin is not a terminal and --yes is absent (subprocess)", () => {
    expect(setup().code).toBe(0);
    const before = listTree(fx.root);
    const r = spawnSync(process.execPath, [join(HERE, "uninstall.mjs")], { env: fx.env, input: "", encoding: "utf8", timeout: 10000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a terminal; re-run with --yes/);
    expect(listTree(fx.root)).toEqual(before);
  });

  it("--yes skips the prompt (subprocess)", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    const r = spawnSync(process.execPath, [join(HERE, "uninstall.mjs"), "--yes"], { env: fx.env, input: "", encoding: "utf8", timeout: 10000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(L.wrapper)).toBe(false);
  });
});

describe("doctor", () => {
  it("tells you to re-run setup when the built manifest has no key", () => {
    expect(setup().code).toBe(0);
    writeFileSync(join(fx.scoutRoot, "packages/browser-extension/dist/manifest.json"), JSON.stringify(FAKE_MANIFEST));
    const r = runChecks(fx.env).find((x) => x.label === "built extension manifest key derives extensionId");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/has no key; re-run `npm run setup`/);
  });

  it("reports all OK after a fresh setup", () => {
    expect(setup().code).toBe(0);
    const c = capture();
    const code = runDoctor(fx.env, c.out);
    expect(code, c.text()).toBe(0);
    expect(c.text()).not.toMatch(/^FAIL/m);
  });

  it("reports WARN, not FAIL, without an agent profile", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    spawnSync("rm", [L.agentProfile]);
    const results = runChecks(fx.env);
    expect(results.find((r) => r.label === "agent profile")).toMatchObject({ status: "WARN", section: "CLI" });
    expect(results.filter((r) => r.status === "FAIL")).toEqual([]);
  });

  it("reports FAIL when a path breaks or a mode drifts", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    writeFileSync(L.agentProfile, JSON.stringify({ ...json(L.agentProfile), claudePath: join(fx.root, "missing", "claude") }));
    chmodSync(L.wrapper, 0o755);
    chmodSync(L.keyPem, 0o644);
    const c = capture();
    expect(runDoctor(fx.env, c.out)).toBe(1);
    const failed = runChecks(fx.env).filter((r) => r.status === "FAIL").map((r) => r.label);
    expect(failed).toEqual(["wrapper mode is 0700", "extension key is a 0600 file", "agent profile names an executable claude"]);
  });

  it("reports FAIL when a marker differs or a dir or manifest mode drifts", () => {
    expect(setup().code).toBe(0);
    const L = layout({ env: fx.env, scoutRoot: fx.scoutRoot });
    writeFileSync(L.scoutConfig, JSON.stringify({ ...json(L.scoutConfig), x_scout_marker: "other" }));
    chmodSync(L.scoutConfig, 0o600);
    chmodSync(L.nmhManifest, 0o600);
    chmodSync(L.binDir, 0o755);
    const failed = runChecks(fx.env).filter((r) => r.status === "FAIL").map((r) => r.label);
    expect(failed).toEqual(["scout config carries the recorded marker", "scout bin dir is a 0700 dir owned by you", "native messaging manifest is a 0644 file"]);
  });

  it("reports FAIL when nothing is installed and writes nothing", () => {
    const before = listTree(fx.root);
    const c = capture();
    expect(runDoctor(fx.env, c.out)).toBe(1);
    expect(listTree(fx.root)).toEqual(before);
  });
});
