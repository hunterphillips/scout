import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRuntimeDir, coreSocketPath, readExtensionId, scoutHome } from "./config.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const uid = process.getuid!();

let home: string;
let server: Server | null = null;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-home-"));
});
afterEach(() => {
  chmodSync(home, 0o700);
  server?.close();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

const listen = async (path: string, mode = 0o600) => {
  server = createServer();
  await new Promise<void>((r) => server!.listen(path, r));
  chmodSync(path, mode);
};

describe("config", () => {
  it("reads extensionId from <SCOUT_HOME>/config.json", () => {
    expect(scoutHome({ SCOUT_HOME: home })).toBe(home);
    expect(coreSocketPath(home)).toBe(join(home, "run", "core.sock"));
    expect(readExtensionId(home)).toBeUndefined();
    writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, nodePath: "/x" }));
    expect(readExtensionId(home)).toBe(EXT_ID);
    writeFileSync(join(home, "config.json"), "{broken");
    expect(readExtensionId(home)).toBeUndefined();
  });
});

describe("checkRuntimeDir", () => {
  it("reports missing when the dir or socket does not exist", () => {
    const path = coreSocketPath(home);
    expect(checkRuntimeDir(path)).toEqual({ status: "missing" });
    mkdirSync(join(home, "run"), { mode: 0o700 });
    expect(checkRuntimeDir(path)).toEqual({ status: "missing" });
  });

  it("refuses, not retries, when the runtime dir cannot be inspected (EACCES)", () => {
    mkdirSync(join(home, "run"), { mode: 0o700 });
    chmodSync(home, 0o000);
    expect(checkRuntimeDir(coreSocketPath(home))).toEqual({ status: "refused", reason: "runtime-dir-unreadable" });
  });

  it("accepts a 0700 dir holding a private socket", async () => {
    mkdirSync(join(home, "run"), { mode: 0o700 });
    await listen(coreSocketPath(home));
    expect(checkRuntimeDir(coreSocketPath(home))).toEqual({ status: "ok" });
  });

  it.each([
    ["dir not 0700", 0o750, "runtime-dir-not-private"],
    ["dir world-readable", 0o705, "runtime-dir-not-private"],
  ] as const)("refuses when the %s", (_name, mode, reason) => {
    mkdirSync(join(home, "run"));
    chmodSync(join(home, "run"), mode);
    expect(checkRuntimeDir(coreSocketPath(home))).toEqual({ status: "refused", reason });
  });

  it("refuses a symlinked runtime dir", () => {
    mkdirSync(join(home, "real"), { mode: 0o700 });
    symlinkSync(join(home, "real"), join(home, "run"));
    expect(checkRuntimeDir(coreSocketPath(home))).toEqual({
      status: "refused",
      reason: "runtime-dir-not-directory",
    });
  });

  it("refuses a dir or socket owned by someone else", async () => {
    mkdirSync(join(home, "run"), { mode: 0o700 });
    expect(checkRuntimeDir(coreSocketPath(home), uid + 1)).toEqual({
      status: "refused",
      reason: "runtime-dir-wrong-owner",
    });
  });

  it("refuses a socket with group/other bits, and a non-socket", async () => {
    mkdirSync(join(home, "run"), { mode: 0o700 });
    const path = coreSocketPath(home);
    await listen(path, 0o660);
    expect(checkRuntimeDir(path)).toEqual({ status: "refused", reason: "socket-not-private" });
    server!.close();
    server = null;
    rmSync(path, { force: true });
    writeFileSync(path, "");
    expect(checkRuntimeDir(path)).toEqual({ status: "refused", reason: "socket-not-socket" });
    rmSync(path);
    symlinkSync(join(home, "elsewhere.sock"), path);
    expect(checkRuntimeDir(path)).toEqual({ status: "refused", reason: "socket-not-socket" });
  });
});
