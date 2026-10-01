import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceText, redactReport, redactString, summarizeInit, TEXT_MAX, writeReport } from "./report.mjs";

const env = { HOME: "/Users/someone" };
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("redaction", () => {
  it("shows $HOME paths as ~ and replaces secrets", () => {
    const o = { env, secrets: ["tok-123456"] };
    expect(redactString("/Users/someone/.claude/skills/x", o)).toBe("~/.claude/skills/x");
    expect(redactString("/Users/someone", o)).toBe("~");
    expect(redactString("/Users/someoneelse/x", o)).toBe("/Users/someoneelse/x");
    expect(redactString("a tok-123456 b", o)).toBe("a <redacted> b");
    expect(redactReport({ "/Users/someone/k": ["/Users/someone/a", 3, null, { t: "tok-123456" }] }, o)).toEqual({ "~/k": ["~/a", 3, null, { t: "<redacted>" }] });
  });

  it("bounds model text", () => {
    expect(evidenceText("x".repeat(TEXT_MAX + 50), { env })).toHaveLength(TEXT_MAX + 3);
    expect(evidenceText(undefined, { env })).toBeUndefined();
  });

  it("names only Scout's servers, tools and skills from the init event", () => {
    const init = {
      claude_code_version: "2.1.286",
      model: "claude-sonnet-5-5",
      mcp_servers: [{ name: "scout-proof-x", status: "connected" }, { name: "personal-thing", status: "connected" }],
      tools: ["Skill", "Bash", "mcp__personal-thing__read", "mcp__scout-proof-x__read_resource"],
      skills: ["my-private-skill", "scout-proof-x"],
    };
    const s = summarizeInit(init, { server: (n) => n === "scout-proof-x", tool: (t) => t === "Skill" || t.startsWith("mcp__scout-proof-x__"), skill: (n) => n.startsWith("scout-proof-") });
    expect(s).toMatchObject({ mcpServers: [{ name: "scout-proof-x", status: "connected" }], otherMcpServers: 1, tools: ["Skill", "mcp__scout-proof-x__read_resource"], otherTools: 2, skills: ["scout-proof-x"], otherSkills: 1 });
    expect(JSON.stringify(s)).not.toMatch(/personal-thing|my-private-skill/);
    expect(summarizeInit(undefined, {})).toEqual({ seen: false });
  });
});

describe("writeReport", () => {
  it("writes a private, redacted file under <home>/agent-check", () => {
    const home = mkdtempSync(join(tmpdir(), "rep-"));
    dirs.push(home);
    const { path, report } = writeReport(home, "baseline", { argv: ["/Users/someone/.local/bin/claude"], note: "tok-123456" }, { env, secrets: ["tok-123456"] });
    expect(path.startsWith(join(home, "agent-check", "baseline-"))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "agent-check")).mode & 0o777).toBe(0o700);
    expect(report.argv).toEqual(["~/.local/bin/claude"]);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("tok-123456");
    expect(text).not.toContain("/Users/someone/");
  });
});
