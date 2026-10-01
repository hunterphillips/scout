import { describe, expect, it } from "vitest";
import { checkInit, type ExpectedInit } from "./initCheck.js";

const scoutTools = ["current_site", "recent_activity", "site_links", "list_resources", "read_resource"].map((t) => `mcp__scout__${t}`);
const bridgeTools = ["mcp__bridge__search"];
const twoBridgeTools = ["mcp__bridge__search", "mcp__bridge__lookup"];

const expected = (extra: Partial<ExpectedInit> = {}): ExpectedInit => ({
  servers: [
    { name: "scout", tools: scoutTools, required: true, optionalTools: [] },
    { name: "bridge", tools: bridgeTools, required: false, optionalTools: bridgeTools },
  ],
  model: "claude-sonnet-5-5",
  cliVersion: "2.1.286",
  ...extra,
});

const good = (patch: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  tools: [...scoutTools, ...bridgeTools, "StructuredOutput"],
  mcp_servers: [
    { name: "scout", status: "connected" },
    { name: "bridge", status: "connected" },
  ],
  model: "claude-sonnet-5-5",
  permissionMode: "dontAsk",
  apiKeySource: "none",
  claude_code_version: "2.1.286",
  ...patch,
});

describe("checkInit", () => {
  it("accepts exactly the expected surface, with or without a first-party apiProvider", () => {
    expect(checkInit(good(), expected())).toEqual({ ok: true, optionalUnavailable: [], model: "claude-sonnet-5-5", cliVersion: "2.1.286" });
    expect(checkInit(good({ apiProvider: "firstParty" }), expected()).ok).toBe(true);
  });

  it("reports each tool of an optional server that did not load and carries on", () => {
    const init = good({ tools: [...scoutTools, "StructuredOutput"], mcp_servers: [{ name: "scout", status: "connected" }, { name: "bridge", status: "failed" }] });
    expect(checkInit(init, expected())).toMatchObject({ ok: true, optionalUnavailable: bridgeTools });
    const absent = good({ tools: [...scoutTools, "StructuredOutput"], mcp_servers: [{ name: "scout", status: "connected" }] });
    expect(checkInit(absent, expected())).toMatchObject({ ok: true, optionalUnavailable: bridgeTools });
  });

  // Availability is per tool: a connected server missing one optional tool keeps the others.
  const partial = (required: boolean, optionalTools: string[]): Partial<ExpectedInit> => ({
    servers: [
      { name: "scout", tools: scoutTools, required: true, optionalTools: [] },
      { name: "bridge", tools: twoBridgeTools, required, optionalTools },
    ],
  });
  const onlySearch = { tools: [...scoutTools, "mcp__bridge__search", "StructuredOutput"] };

  it("a connected optional server missing one of its tools: that tool is reported, the job goes on", () => {
    expect(checkInit(good(onlySearch), expected(partial(false, twoBridgeTools)))).toMatchObject({ ok: true, optionalUnavailable: ["mcp__bridge__lookup"] });
  });

  it("a required server missing only an optional tool goes on; missing a required tool stops", () => {
    expect(checkInit(good(onlySearch), expected(partial(true, ["mcp__bridge__lookup"])))).toMatchObject({ ok: true, optionalUnavailable: ["mcp__bridge__lookup"] });
    expect(checkInit(good({ tools: [...scoutTools, "mcp__bridge__lookup"] }), expected(partial(true, ["mcp__bridge__lookup"])))).toEqual({ ok: false, reason: "tool_unavailable", detail: "required_tool_missing" });
  });

  it("a required bridge that failed to connect stops the job even if some of its tools are optional", () => {
    const init = good({ tools: [...scoutTools], mcp_servers: [{ name: "scout", status: "connected" }, { name: "bridge", status: "failed" }] });
    expect(checkInit(init, expected(partial(true, ["mcp__bridge__lookup"])))).toEqual({ ok: false, reason: "tool_unavailable", detail: "required_server_unavailable" });
  });

  it.each<[string, Record<string, unknown>, Partial<ExpectedInit>, string, string]>([
    ["an extra server", { mcp_servers: [{ name: "scout", status: "connected" }, { name: "other", status: "connected" }] }, {}, "unsupported_configuration", "extra_server"],
    ["a duplicated server", { mcp_servers: [{ name: "scout", status: "connected" }, { name: "scout", status: "connected" }] }, {}, "unsupported_configuration", "extra_server"],
    ["a built-in tool", { tools: [...scoutTools, "Bash", "StructuredOutput"] }, {}, "unsupported_configuration", "extra_tool"],
    ["the Skill tool", { tools: [...scoutTools, "Skill"] }, {}, "unsupported_configuration", "extra_tool"],
    ["permission mode default", { permissionMode: "default" }, {}, "unsupported_configuration", "permission_mode"],
    ["another model", { model: "claude-opus-other" }, {}, "unsupported_configuration", "model_mismatch"],
    ["another CLI version", { claude_code_version: "2.1.300" }, {}, "unsupported_configuration", "cli_version_changed"],
    ["no CLI version when one was verified", { claude_code_version: undefined }, {}, "unsupported_configuration", "cli_version_changed"],
    ["an API key route", { apiKeySource: "ANTHROPIC_API_KEY" }, {}, "preflight_failed", "auth_route"],
    ["a Bedrock provider", { apiProvider: "bedrock" }, {}, "preflight_failed", "auth_route"],
    ["the required server failed", { mcp_servers: [{ name: "scout", status: "failed" }, { name: "bridge", status: "connected" }], tools: [...bridgeTools] }, {}, "tool_unavailable", "required_server_unavailable"],
    ["the required server absent", { mcp_servers: [{ name: "bridge", status: "connected" }], tools: [...bridgeTools] }, {}, "tool_unavailable", "required_server_unavailable"],
    ["a required tool missing", { tools: [...scoutTools.slice(1), ...bridgeTools] }, {}, "tool_unavailable", "required_tool_missing"],
    ["no tools array", { tools: undefined }, {}, "unsupported_configuration", "malformed_init"],
    ["a malformed server entry", { mcp_servers: ["scout"] }, {}, "unsupported_configuration", "malformed_init"],
  ])("rejects %s", (_l, patch, exp, reason, detail) => {
    expect(checkInit(good(patch), expected(exp))).toEqual({ ok: false, reason, detail });
  });

  it("does not compare versions when the preflight could not tell", () => {
    const { cliVersion: _v, ...noVersion } = expected();
    expect(checkInit(good({ claude_code_version: "9.9.9" }), noVersion)).toMatchObject({ ok: true, cliVersion: "9.9.9" });
  });
});
