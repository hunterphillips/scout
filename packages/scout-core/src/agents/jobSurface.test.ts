import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJobSurface, defaultScoutMcpEntrypoint, JobSurfaceError, scoutOnlySurface, scoutServerSpec, type JobServerSpec } from "./jobSurface.js";

const scoutOpts = { nodePath: "/usr/local/bin/node", entrypoint: "/x/scout-mcp/dist/main.js", socketPath: "/h/run/agent.sock", tokenFile: "/h/run/jobs/j/agent-token" };
const SCOUT_ALLOWED = ["current_site", "recent_activity", "site_links", "list_resources", "read_resource"].map((t) => `mcp__scout__${t}`);

describe("job surface", () => {
  it("builds Scout's strict MCP config and the exact allowed-tool list", () => {
    const s = buildJobSurface(scoutOnlySurface(scoutOpts));
    expect(s.mcpConfig).toEqual({
      mcpServers: { scout: { type: "stdio", command: scoutOpts.nodePath, args: [scoutOpts.entrypoint, "--socket", scoutOpts.socketPath, "--token-file", scoutOpts.tokenFile] } },
    });
    expect(s.allowedToolsArg).toBe(SCOUT_ALLOWED.join(","));
    expect(s.allowedToolsArg).not.toContain("*");
    expect(s.expected).toEqual([{ name: "scout", tools: SCOUT_ALLOWED, required: true }]);
  });

  it("takes further servers through the same description (the P1.3 seam)", () => {
    const extra: JobServerSpec = { name: "bridge", command: "/usr/local/bin/node", args: ["/b.js"], env: { MODE: "x" }, tools: ["search", "fetch"], required: false };
    const s = buildJobSurface({ servers: [scoutServerSpec(scoutOpts), extra], allowedTools: [...SCOUT_ALLOWED, "mcp__bridge__search"] });
    expect(Object.keys(s.mcpConfig.mcpServers)).toEqual(["scout", "bridge"]);
    expect(s.mcpConfig.mcpServers.bridge!.env).toEqual({ MODE: "x" });
    expect(s.allowedTools.has("mcp__bridge__fetch")).toBe(false); // advertised, not allowed
    expect(s.expected[1]).toEqual({ name: "bridge", tools: ["mcp__bridge__search", "mcp__bridge__fetch"], required: false });
  });

  it.each<[string, () => unknown]>([
    ["a wildcard allowed tool", () => buildJobSurface({ servers: [scoutServerSpec(scoutOpts)], allowedTools: ["mcp__scout__*"] })],
    ["an allowed tool no server advertises", () => buildJobSurface({ servers: [scoutServerSpec(scoutOpts)], allowedTools: ["Bash"] })],
    ["a relative command", () => buildJobSurface({ servers: [{ ...scoutServerSpec(scoutOpts), command: "node" }], allowedTools: [] })],
    ["a duplicate server name", () => buildJobSurface({ servers: [scoutServerSpec(scoutOpts), scoutServerSpec(scoutOpts)], allowedTools: [] })],
    ["a server name that is not plain", () => buildJobSurface({ servers: [{ ...scoutServerSpec(scoutOpts), name: "a__b c" }], allowedTools: [] })],
    ["no servers", () => buildJobSurface({ servers: [], allowedTools: [] })],
  ])("refuses %s", (_l, fn) => {
    expect(fn).toThrow(JobSurfaceError);
  });

  it("resolves the built scout-mcp entrypoint", () => {
    const p = defaultScoutMcpEntrypoint();
    expect(p).toMatch(/scout-mcp\/dist\/main\.js$/);
    expect(existsSync(p)).toBe(true);
  });
});
