import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_AGENT_OUTPUT_JSON_SCHEMA } from "@scout/contracts";
import { buildPiArgv, createPiLaunch } from "./launch.js";
import { createPiWorld, dummySurface, type PiWorld } from "./testing/testWorld.js";

const worlds: PiWorld[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup();
});

function setup(): PiWorld {
  const world = createPiWorld();
  worlds.push(world);
  return world;
}

describe("Pi launch", () => {
  it("uses exact Scout tools and no model flag when the profile omits it", () => {
    const world = setup();
    const made = createPiLaunch({
      home: world.home,
      profile: world.profile,
      parentEnv: world.env,
      requestId: "pi-test",
      surface: dummySurface,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const { launch } = made;
    expect(launch.argv).not.toContain("--model");
    expect(launch.argv).not.toContain("--api-key");
    expect(launch.argv[launch.argv.indexOf("--tools") + 1]?.split(",")).toEqual([
      ...launch.toolSurface.expected[0]!.tools,
      "scout_answer",
    ]);
    expect(Object.keys(launch.env).sort()).toEqual([
      "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
      "SCOUT_PI_ANSWER_SCHEMA", "USER",
    ].sort());
    expect(JSON.parse(readFileSync(join(launch.jobDir, "answer-schema.json"), "utf8"))).toEqual(JOB_AGENT_OUTPUT_JSON_SCHEMA);
    launch.cleanup();
  });

  it("copies only four model settings and removes only job files", () => {
    const world = setup();
    writeFileSync(join(world.root, ".pi", "agent", "settings.json"), JSON.stringify({
      deviceId: "device",
      defaultProvider: "openai",
      defaultModel: "gpt-6-sol",
      enabledModels: ["openai/gpt-6-sol"],
      hooks: "forbidden",
    }));
    const made = createPiLaunch({
      home: world.home,
      profile: world.profile,
      parentEnv: world.env,
      requestId: "pi-test",
      surface: dummySurface,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const { launch } = made;
    const agentDir = join(launch.jobDir, "pi-agent");
    expect(readdirSync(agentDir).sort()).toEqual(["auth.json", "mcp.json", "settings.json"]);
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      quietStartup: true,
      deviceId: "device",
      defaultProvider: "openai",
      defaultModel: "gpt-6-sol",
      enabledModels: ["openai/gpt-6-sol"],
    });
    expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers.scout.exposure).toBe("direct");
    launch.cleanup();
    expect(existsSync(launch.jobDir)).toBe(false);
    expect(existsSync(join(world.root, ".pi", "agent", "auth.json"))).toBe(true);
  });

  it("adds --model only for a provider-qualified model", () => {
    const world = setup();
    const argv = buildPiArgv({
      profile: { ...world.profile, model: "openai/gpt-6-sol" },
      surface: { expected: [{ name: "scout", tools: ["mcp__scout__current_site"], required: true, optionalTools: [] }] },
    });
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual([
      "--model", "openai/gpt-6-sol",
    ]);
  });

  it("ships the dependency-free answer extension in dist", async () => {
    const world = setup();
    const schema = join(world.root, "schema.json");
    writeFileSync(schema, JSON.stringify({ type: "object", required: ["status"] }));
    const prior = process.env.SCOUT_PI_ANSWER_SCHEMA;
    try {
      process.env.SCOUT_PI_ANSWER_SCHEMA = schema;
      const extension = await import(new URL("../../../dist/agents/pi/answerExtension.mjs", import.meta.url).href);
      let registered: { parameters: unknown; execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
      extension.default({
        registerTool: (tool: typeof registered) => {
          registered = tool;
        },
        getAllTools: () => [{ name: "mcp__scout__current_site" }, { name: "bash" }],
      });
      expect(registered?.parameters).toEqual(JSON.parse(readFileSync(schema, "utf8")));
      expect(await registered?.execute("x", { status: "empty" })).toMatchObject({
        details: { answer: { status: "empty" }, scoutTools: 1 },
        terminate: true,
      });
    } finally {
      if (prior === undefined) delete process.env.SCOUT_PI_ANSWER_SCHEMA;
      else process.env.SCOUT_PI_ANSWER_SCHEMA = prior;
    }
  });
});
