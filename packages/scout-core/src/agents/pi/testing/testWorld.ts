// Shared test world for the Pi module tests. It uses only fake Pi and fixture backends.
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRequest } from "@scout/contracts";
import type { JobDetails } from "../../adapter.js";
import { profileFingerprint } from "../../profile.js";
import type { PiProfile } from "../profile.js";
import { fakeUserPiAgentDir, installFakePi, type FakePi } from "./fakePi.js";

export interface PiWorld {
  root: string;
  home: string;
  fake: FakePi;
  profile: PiProfile;
  env: Record<string, string>;
  cleanup(): void;
}

export function createPiWorld(mode = "ok"): PiWorld {
  const root = mkdtempSync(join(tmpdir(), "scout-pi-"));
  chmodSync(root, 0o700);
  fakeUserPiAgentDir(root);
  const fake = installFakePi(root, { mode });
  const home = join(root, "scout");
  mkdirSync(home, { mode: 0o700 });
  const profile: PiProfile = {
    schemaVersion: 1,
    adapter: "pi",
    piPath: fake.path,
    thinking: "low",
  };
  const env = { HOME: root, PATH: `${join(root, "bin")}:/usr/bin:/bin`, USER: "test" };
  return { root, home, fake, profile, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const dummySurface = {
  scout: { socketPath: "/tmp/scout-pi-test.sock", token: "a".repeat(32) },
};

export function jobDetails(): JobDetails {
  return {
    adapter: "pi",
    termination: "completed",
    toolUses: [],
    optionalTools: [],
    droppedPicks: 0,
    cutPicks: 0,
    toolErrors: {},
    optionalToolFailed: false,
    timings: { totalMs: 0 },
    usage: {},
  };
}

export function jobRequest(world: PiWorld, extra: Partial<JobRequest> = {}): JobRequest {
  return {
    requestId: "job-1",
    coreInstanceId: "core-test",
    visitEpoch: 7,
    origin: "https://docs.example.com",
    catalogHash: "cat-1",
    browserSnapshot: { id: "snap-1", revision: 1 },
    approvalRevision: 0,
    grantRevision: 0,
    profileFingerprint: profileFingerprint(world.profile),
    deadlineMs: 10_000,
    candidates: [{ id: "c1", title: "Usage billing guide", description: "Meter calls", labelQuality: "published" }],
    maxPicks: 3,
    ...extra,
  };
}

export async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function expectAllGoneWithin(pids: number[], ms = 3000): Promise<void> {
  await waitFor(() => pids.every((pid) => !alive(pid)), ms);
}
