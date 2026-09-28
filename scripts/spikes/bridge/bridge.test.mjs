import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runEchoTest, startHost, startServer, TEST_EXTENSION_ID } from "./echo-test.mjs";
import { frameHeader } from "./framing.mjs";
import { HOST_NAME } from "./native-host.mjs";
import { prepareNativeHost, shQuote } from "./prepare-host.mjs";

const roots = [];
const tmp = (prefix) => {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  return r;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("native host wrapper and manifest", () => {
  it("quotes paths with spaces and quotes for /bin/sh", () => {
    const tricky = "/tmp/it's a $path `x` \"y\"";
    const r = spawnSync("/bin/sh", ["-c", `printf %s ${shQuote(tricky)}`], { encoding: "utf8" });
    expect(r.stdout).toBe(tricky);
    expect(() => shQuote("a\nb")).toThrow();
  });

  it("writes an absolute-path manifest with one exact origin and manual-only install scripts", () => {
    const root = tmp("scout prep ");
    const p = prepareNativeHost({ outDir: join(root, "out dir"), runtimeDir: join(root, "run time"), extensionId: TEST_EXTENSION_ID });
    const m = JSON.parse(readFileSync(p.manifestPath, "utf8"));
    expect(m).toEqual({
      name: HOST_NAME,
      description: expect.any(String),
      path: p.wrapperPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${TEST_EXTENSION_ID}/`],
    });
    expect(p.wrapperPath.startsWith("/")).toBe(true);
    const wrapper = readFileSync(p.wrapperPath, "utf8");
    expect(wrapper).toContain(`exec '${process.execPath}'`);
    expect(wrapper).toContain(`cd -- '${join(root, "run time")}'`);
    const install = readFileSync(p.installPath, "utf8");
    expect(install).toContain("Library/Application Support/Google/Chrome/NativeMessagingHosts");
    expect(install).toContain("refusing");
    expect(readFileSync(p.uninstallPath, "utf8")).toContain("cmp -s");
    expect(() => prepareNativeHost({ outDir: root, runtimeDir: join(root, "r2"), extensionId: "NOT-AN-ID" })).toThrow();
  });
});

describe("private runtime dir", () => {
  it("refuses an existing runtime dir that is not 0700, or a symlink", async () => {
    const root = tmp("scout rt ");
    const loose = join(root, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const s1 = startServer(loose);
    expect(await s1.ready).toEqual({ event: "error", code: "runtime-dir-not-private" });
    await s1.exited;
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "link"));
    const s2 = startServer(join(root, "link"));
    expect(await s2.ready).toEqual({ event: "error", code: "runtime-dir-not-directory" });
    await s2.exited;
  });

  it("host refuses to start from a non-private runtime dir", async () => {
    const root = tmp("scout rt2 ");
    const p = prepareNativeHost({ outDir: join(root, "out"), runtimeDir: join(root, "run"), extensionId: TEST_EXTENSION_ID });
    chmodSync(join(root, "run"), 0o750);
    const h = startHost(p.wrapperPath, p.origin);
    const f = await h.next(() => true, 5000);
    expect(f).toEqual({ type: "error", code: "runtime-dir-not-private" });
    expect((await h.exited).code).toBe(1);
    chmodSync(join(root, "run"), 0o700);
  });
});

describe("handshake", () => {
  it("a malformed frame before hello ends the session; a later hello is not accepted", async () => {
    const root = tmp("scout hs ");
    const p = prepareNativeHost({ outDir: join(root, "out"), runtimeDir: join(root, "run"), extensionId: TEST_EXTENSION_ID });
    const h = startHost(p.wrapperPath, p.origin);
    const bad = Buffer.from("{not json", "utf8");
    const hello = Buffer.from(JSON.stringify({ type: "hello", protocol: 1 }), "utf8");
    // One write, so the hello can arrive in the same chunk as the bad frame.
    h.writeRaw(Buffer.concat([frameHeader(bad.length), bad, frameHeader(hello.length), hello]));
    const exit = await Promise.race([h.exited, new Promise((r) => setTimeout(() => r("still-running"), 3000))]);
    const frames = [...h.frames.items];
    if (exit === "still-running") await h.close();
    expect(frames[0]).toEqual({ type: "error", code: "invalid-json" });
    expect(frames.some((f) => f.type === "hello-ack")).toBe(false);
    expect(exit).toEqual({ code: 1, signal: null });
  });
});

describe("owned server startup failure", () => {
  it("a second server on a live runtime dir fails, exits, and leaves the first one and its socket alone", async () => {
    const root = tmp("scout dup ");
    const dir = join(root, "run");
    const a = startServer(dir);
    expect((await a.ready).event).toBe("ready");
    const b = startServer(dir);
    expect(await b.ready).toEqual({ event: "error", code: "already-running" });
    expect((await b.exited).code).toBe(1);
    await b.stop(); // stopping a failed child is a bounded no-op
    expect(a.child.exitCode).toBeNull();
    expect(existsSync(join(dir, "bridge.sock"))).toBe(true);
    const exit = await a.stop();
    expect(exit.code).toBe(0); // clean stdin-EOF shutdown, no signal needed
    expect(existsSync(join(dir, "bridge.sock"))).toBe(false);
  });
});

describe("hermetic echo test (real child host + real Unix socket)", () => {
  it("passes every check and leaves nothing behind", async () => {
    const r = await runEchoTest({ scratchRoot: tmp("scout-echo-root-") });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    const names = r.checks.map((c) => c.name);
    for (const n of [
      "socket-path-exceeds-sun_path",
      "wrong-origin-rejected",
      "hello-required-first",
      "100-acks-match",
      "over-cap-rejected",
      "rejects-not-forwarded",
      "drop-while-disconnected",
      "reconnect-within-schedule",
      "schedule-exhausts-to-idle",
      "no-retry-after-exhaustion",
      "manual-reconnect",
      "truncated-at-eof",
      "cleanup-no-owned-process",
      "cleanup-no-socket",
    ]) {
      expect(names).toContain(n);
    }
    expect(r.ok).toBe(true);
  }, 60_000);
});
