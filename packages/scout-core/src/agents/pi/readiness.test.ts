import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, readdirSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { runPiReadiness } from "./readiness.js";
import { createPiReadinessFacade } from "./readinessWorker.js";
import { createPiWorld, type PiWorld } from "./testing/testWorld.js";

const worlds: PiWorld[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup();
});

function setup(): PiWorld {
  const world = createPiWorld();
  worlds.push(world);
  return world;
}

const input = (world: PiWorld) => ({
  home: world.home,
  parentEnv: world.env,
  piPath: world.fake.path,
  profile: world.profile,
});

describe("Pi readiness", () => {
  it("checks only version and model listing, then removes its temporary dir", () => {
    const world = setup();
    expect(runPiReadiness(input(world))).toEqual({ verdict: "ready", reasons: [], version: "1.0.4" });
    expect(world.fake.lines().filter((line) => line.sub).map((line) => line.argv)).toEqual([
      ["--version"],
      ["--list-models"],
    ]);
    expect(readdirSync(join(world.home, "run", "jobs"))).toEqual([]);
  });

  it("reports not_logged_in when no models are available", () => {
    const world = setup();
    world.fake.setLogin("none");
    expect(runPiReadiness(input(world)).reasons).toContain("not_logged_in");
  });

  it("passes an explicit model to --list-models and reports model_not_found", () => {
    const world = setup();
    const report = runPiReadiness({
      ...input(world),
      profile: { ...world.profile, model: "openai/no-such-model" },
    });
    expect(report.reasons).toEqual(["model_not_found"]);
    expect(world.fake.lines().filter((line) => line.sub).at(-1)?.argv).toEqual([
      "--list-models", "openai/no-such-model",
    ]);
  });

  it("reports node_too_old for the core node before 22.19", () => {
    const world = setup();
    expect(runPiReadiness({ ...input(world), nodeVersion: "22.12.0" }).reasons).toContain("node_too_old");
  });

  it("reports version_unknown for an unparseable version", () => {
    const world = setup();
    world.fake.setVersion("unknown");
    expect(runPiReadiness(input(world)).reasons).toContain("version_unknown");
  });

  it("reports auth_link_invalid when the user's auth target is missing or not 0600", () => {
    const world = setup();
    const auth = join(world.root, ".pi", "agent", "auth.json");
    chmodSync(auth, 0o644);
    const later = new Date(Date.now() + 2000);
    utimesSync(auth, later, later);
    expect(runPiReadiness(input(world)).reasons).toContain("auth_link_invalid");
    chmodSync(auth, 0o600);
    unlinkSync(auth);
    expect(runPiReadiness(input(world)).reasons).toContain("auth_link_invalid");
  });

  it("invalidates its cached verdict when auth.json changes", async () => {
    const world = setup();
    const facade = createPiReadinessFacade({ run: async (data) => runPiReadiness(data) });
    const first = await facade(input(world));
    expect(first.verdict).toBe("ready");
    expect((await facade(input(world))).verdict).toBe("ready");
    expect(facade.runs).toBe(1);
    const auth = join(world.root, ".pi", "agent", "auth.json");
    chmodSync(auth, 0o644);
    const later = new Date(Date.now() + 2000);
    utimesSync(auth, later, later);
    expect((await facade(input(world))).reasons).toContain("auth_link_invalid");
    expect(facade.runs).toBe(2);
    facade.cancelAll();
  });
});
