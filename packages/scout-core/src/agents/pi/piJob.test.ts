// Pi jobs against the fake CLI and real fixture MCP socket. No test calls a model.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JobRequest } from "@scout/contracts";
import { fakeBackend, selection, type FakeBackendDef } from "../testing/fakeBackend.js";
import { createPiJobAdapter, type PiJobAdapter } from "./piJob.js";
import { startFixtureCore, type FixtureCore } from "./testing/fakePi.js";
import { createPiWorld, dummySurface, expectAllGoneWithin, jobRequest, waitFor, type PiWorld } from "./testing/testWorld.js";

type World = PiWorld & {
  core?: FixtureCore;
  adapter?: PiJobAdapter;
  backend?: FakeBackendDef;
};
const worlds: World[] = [];

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.adapter?.abortAll();
    for (const pid of [...world.fake.pids(), ...(world.backend?.pids() ?? [])]) killQuietly(pid);
    await world.core?.close();
    world.cleanup();
  }
});

async function setup(mode = "ok", tool?: { required: boolean }): Promise<World> {
  const world: World = createPiWorld(mode);
  worlds.push(world);
  if (tool) {
    world.backend = fakeBackend(world.root, "notes", "honest");
    world.profile.tools = {
      connections: [world.backend.connection],
      selections: [selection("notes", "lookup", tool.required)],
    };
  }
  world.core = await startFixtureCore(world.root);
  world.adapter = createPiJobAdapter({
    home: world.home,
    profile: world.profile,
    parentEnv: world.env,
    minLaunchMs: 0,
    killGraceMs: 100,
  });
  expect((await world.adapter.refreshReadiness()).ok).toBe(true);
  return world;
}

function surface(world: World) {
  return { scout: { socketPath: world.core!.socketPath, token: world.core!.token } };
}

async function run(world: World, extra: Partial<JobRequest> = {}) {
  return world.adapter!.run(jobRequest(world, extra), { toolSurface: surface(world) });
}

describe("Pi job against the fixture MCP server", { timeout: 20_000 }, () => {
  it.each([
    ["ok", "ok"],
    ["empty", "empty"],
    ["answer-rejected", "ok"],
    ["retry", "ok"],
    ["no-answer", "error"],
    ["no-scout-tools", "error"],
    ["model-error", "unavailable"],
    ["builtin-tool", "error"],
    ["codemode", "error"],
    ["many-turns", "error"],
  ])("%s yields %s", async (mode, status) => {
    const world = await setup(mode);
    const outcome = await run(world);
    expect(outcome.result.status).toBe(status);
    expect(existsSync(join(world.home, "run", "jobs", "job-1"))).toBe(false);
    if (mode === "ok") {
      expect(outcome.details.toolUses).toContain("mcp__scout__recent_activity");
      expect(outcome.details.usage.turns).toBeGreaterThan(0);
    }
  });

  it("calls the bridge and carries its reply into the reason", async () => {
    const world = await setup("bridge-call", { required: true });
    const outcome = await run(world);
    expect(outcome.result).toMatchObject({ status: "ok", items: [{ reason: "Matches lookup:metered" }] });
    expect(outcome.details.toolUses).toContain("mcp__scout_bridge__lookup");
    expect(world.backend!.calls()).toEqual(["lookup"]);
    expect(world.fake.lines().find((line) => line.pid)?.violations).toEqual([]);
  });

  it("fails when every call to a required bridge tool errors", async () => {
    const world = await setup("tool-errors", { required: true });
    const outcome = await run(world);
    expect(outcome.result).toMatchObject({ status: "error", reason: "tool_unavailable" });
    expect(outcome.details).toMatchObject({
      detail: "required_tool_failed",
      toolErrors: { mcp__scout_bridge__lookup: 1 },
    });
  });

  it("flags an optional bridge error and keeps the answer", async () => {
    const world = await setup("tool-errors", { required: false });
    const outcome = await run(world);
    expect(outcome.result.status).toBe("ok");
    expect(outcome.details.optionalToolFailed).toBe(true);
    expect(outcome.details.toolErrors.mcp__scout_bridge__lookup).toBe(1);
  });

  it("halts flood output at the 4 MiB cap", async () => {
    const world = await setup("flood");
    const outcome = await run(world);
    expect(outcome.result).toMatchObject({ status: "error", reason: "agent_failed" });
    expect(outcome.details.termination).toBe("output_too_large");
  });

  it("ignores tool and answer events after the first answer", async () => {
    const world = await setup("late-output");
    const outcome = await run(world);
    expect(outcome.result).toMatchObject({ status: "ok", items: [{ id: "c1" }] });
    expect(outcome.details.toolUses).toEqual(["mcp__scout__recent_activity"]);
  });

  it.each(["hang", "ignore-term"])("timeout kills the Pi and MCP child in %s mode", async (mode) => {
    const world = await setup(mode);
    const outcome = await run(world, { deadlineMs: 4000 });
    expect(outcome.result).toMatchObject({ status: "error", reason: "timeout" });
    expect(world.fake.pids().length).toBeGreaterThanOrEqual(2);
    await expectAllGoneWithin(world.fake.pids());
  });

  it.each(["hang", "ignore-term"])("cancel kills the Pi and MCP child in %s mode", async (mode) => {
    const world = await setup(mode);
    const controller = new AbortController();
    const running = world.adapter!.run(jobRequest(world), {
      toolSurface: surface(world),
      signal: controller.signal,
    });
    await waitFor(() => world.fake.pids().length >= 2);
    controller.abort("visit_changed");
    expect((await running).result).toMatchObject({ status: "cancelled", reason: "visit_changed" });
    await expectAllGoneWithin(world.fake.pids());
  });

  it("abortAll cancels a running job and closes the adapter", async () => {
    const world = await setup("hang");
    const running = world.adapter!.run(jobRequest(world), { toolSurface: surface(world) });
    await waitFor(() => world.fake.pids().length >= 2);
    await world.adapter!.abortAll();
    expect((await running).result).toMatchObject({ status: "cancelled", reason: "shutdown" });
    await expectAllGoneWithin(world.fake.pids());
    expect((await run(world)).result).toMatchObject({ status: "unavailable", reason: "agent_unavailable" });
  });
});

describe("Pi job gates without a socket", () => {
  it("blocks profile mismatch and unavailable readiness before spawn", async () => {
    const world: World = createPiWorld();
    worlds.push(world);
    const adapter = createPiJobAdapter({
      home: world.home,
      profile: world.profile,
      parentEnv: world.env,
      minLaunchMs: 0,
    });
    world.adapter = adapter;
    expect((await adapter.refreshReadiness()).ok).toBe(true);
    const mismatch = await adapter.run(
      jobRequest(world, { profileFingerprint: "other" }),
      { toolSurface: dummySurface },
    );
    expect(mismatch.result).toMatchObject({ status: "error", reason: "unsupported_configuration" });
    expect(world.fake.lines().filter((line) => line.pid)).toHaveLength(0);
    await adapter.abortAll();

    world.fake.setLogin("none");
    const unavailable = createPiJobAdapter({
      home: world.home,
      profile: world.profile,
      parentEnv: world.env,
      minLaunchMs: 0,
    });
    world.adapter = unavailable;
    expect((await unavailable.refreshReadiness()).ok).toBe(false);
    expect((await unavailable.run(jobRequest(world), { toolSurface: dummySurface })).result).toMatchObject({
      status: "error",
      reason: "preflight_failed",
    });
    expect(world.fake.lines().filter((line) => line.pid)).toHaveLength(0);
  });
});
