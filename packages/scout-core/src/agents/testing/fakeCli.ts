// Test-only: install the scripted fake `claude` (fake-claude.mjs) behind a wrapper script,
// and start a fixture core on a private Unix socket for the job's real scout-mcp server.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureBackend, type FixtureSeed } from "@scout/scout-mcp/fixture";
import { serveFixture, type FixtureSocket } from "@scout/scout-mcp/testing";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

export interface FakeLogLine {
  argv?: string[];
  cwd?: string;
  envKeys?: string[];
  pid?: number;
  violations?: string[];
  scoutPid?: number;
  prompt?: string;
  /** `sleep-ignore-term`: its in-group and escaped `sleep` descendants. */
  descendantPids?: number[];
}

export interface FakeCli {
  /** The wrapper: an absolute executable, as an agent profile's claudePath. */
  path: string;
  setMode(mode: string): void;
  setVersion(version: string): void;
  lines(): FakeLogLine[];
  /** Every pid the fake reported: the CLI and the scout-mcp servers it started. */
  pids(): number[];
}

/**
 * The wrapper sets the fake's own variables itself, because the launch profile drops
 * unknown env keys. Mode and version are read from files at each launch.
 */
export function installFakeCli(dir: string, mode = "ok", version = "2.1.286"): FakeCli {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const path = join(dir, "bin", "claude");
  const modeFile = join(dir, "fake-mode");
  const versionFile = join(dir, "fake-version");
  const log = join(dir, "fake.log");
  writeFileSync(modeFile, mode);
  writeFileSync(versionFile, version);
  writeFileSync(
    path,
    `#!/bin/sh\nFAKE_MODE="$(cat '${modeFile}')" FAKE_VERSION="$(cat '${versionFile}')" FAKE_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  const lines = (): FakeLogLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeLogLine)
      : [];
  return {
    path,
    setMode: (m) => writeFileSync(modeFile, m),
    setVersion: (v) => writeFileSync(versionFile, v),
    lines,
    pids: () => lines().flatMap((l) => [l.pid, l.scoutPid].filter((p): p is number => typeof p === "number")),
  };
}

export const FIXTURE_TOKEN = "job-token-fixture-1";
export const FIXTURE_ORIGIN = "https://docs.example.com";

export interface FixtureCore {
  socketPath: string;
  token: string;
  socket: FixtureSocket;
  close(): Promise<void>;
}

/** Serve the scout-mcp fixture backend on `<dir>/agent.sock`; `dir` must be private (0700) and short. */
export async function startFixtureCore(dir: string, seed: FixtureSeed = {}): Promise<FixtureCore> {
  const backend = await createFixtureBackend({
    coreInstanceId: "core-test",
    token: FIXTURE_TOKEN,
    browserContextGranted: true,
    currentSite: { origin: FIXTURE_ORIGIN, url: `${FIXTURE_ORIGIN}/billing`, title: "Billing docs", visitEpoch: 7 },
    activity: [{ origin: "https://github.com", url: "https://github.com/o/r/issues/1", observedAt: 1, title: "Issue 1", text: "metered billing", textTruncated: false }],
    ...seed,
  });
  const socketPath = join(dir, "agent.sock");
  const socket = await serveFixture(backend, socketPath);
  return { socketPath, token: FIXTURE_TOKEN, socket, close: () => socket.close() };
}
