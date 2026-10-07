import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileSchema } from "../profile.js";
import { createDefaultPiProfile } from "./profile.js";
import { createPiWorld, type PiWorld } from "./testing/testWorld.js";

const worlds: PiWorld[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup();
});

const setup = (): PiWorld => {
  const world = createPiWorld();
  worlds.push(world);
  return world;
};

describe("Pi profile", () => {
  it("parses with and without a provider-qualified model", () => {
    const world = setup();
    expect(AgentProfileSchema.safeParse(world.profile).success).toBe(true);
    expect(AgentProfileSchema.safeParse({ ...world.profile, model: "openai/gpt-6-sol" }).success).toBe(true);
  });

  it("rejects flag-like and unqualified models", () => {
    const world = setup();
    expect(AgentProfileSchema.safeParse({ ...world.profile, model: "--foo" }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...world.profile, model: "gpt-6-sol" }).success).toBe(false);
  });

  it("finds Pi and leaves model selection to the user's settings", () => {
    const world = setup();
    const profile = createDefaultPiProfile(world.env, { systemDirs: [] });
    expect(profile).toEqual(world.profile);
    expect(profile.model).toBeUndefined();
  });
});
