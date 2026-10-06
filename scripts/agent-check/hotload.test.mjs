// verify:agent --case hotload against the scripted fake CLI: no model, no real config.
// Every path is under a temp root; the "real" skills root and MCP registry are the temp
// HOME's (or the temp CLAUDE_CONFIG_DIR's).

import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeTurn, classifyTurn2, classifyUse, listedSkillNames, proofServerState, readErrorCode } from "./classify.mjs";
import { userSkillsRoot } from "./hotload.mjs";
import { cleanupWorlds, makeWorld, SENTINELS, snapshotTree } from "./test-support.mjs";
import { FOREIGN_SERVER, FOREIGN_SKILL } from "../../packages/scout-core/src/agents/claudeCode/testing/fake-claude-session.mjs";

afterEach(cleanupWorlds);

const proofDirs = (w) => readdirSync(w.skillsRoot).filter((n) => n.startsWith("scout-proof-"));
const sessions = (w) => w.lines().filter((l) => l.session);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (pred, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return pred();
};

function expectClean(w, r, token) {
  expect(r.reportText).toBeDefined();
  for (const s of [token, w.home, homedir(), ...SENTINELS]) expect(r.reportText).not.toContain(s);
  expect(r.reportText).not.toMatch(/"(?:token|ANTHROPIC_[A-Z_]+)"\s*:/);
}

describe("hotload: refusals and dry run", () => {
  it("dry run prints the plan and creates, registers and launches nothing", async () => {
    const w = makeWorld();
    const before = snapshotTree(w.root);
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/proof name \(MCP registration and skill dir\): scout-proof-[a-z0-9]{10}/);
    expect(r.text).toContain(`skills root: ${w.skillsRoot} (exists: yes)`);
    expect(r.text).toContain("mcp add --scope user scout-proof-");
    expect(r.text).toContain("--input-format stream-json");
    expect(r.text).toContain("--tools Skill,ToolSearch");
    expect(r.text).toMatch(/--allowedTools Skill,ToolSearch,mcp__scout-proof-[a-z0-9]{10}__read_resource,mcp__scout-proof-[a-z0-9]{10}__list_resources/);
    expect(r.text).toContain("--max-turns 8");
    expect(r.text).toContain("stands in for an interactive session");
    expect(r.text).toContain("every user-scope MCP server and plugin (counted, not named)");
    expect(r.text).toContain("one per turn");
    expect(r.text).toContain("also on SIGINT/SIGTERM/SIGHUP");
    expect(r.text).toContain("inference requests: at most 2");
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
  });

  it("dry run says a missing skills root would be refused, not created", async () => {
    const w = makeWorld("hotload-watch", { configDir: true });
    w.env.CLAUDE_CONFIG_DIR = join(w.root, "no-such-config");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--dry-run"]);
    expect(r.text).toContain("exists: no; a real run refuses rather than creates it");
  });

  it("refuses without --authorize-real-root or --preliminary: exit 2, nothing changed or launched", async () => {
    const w = makeWorld();
    const before = snapshotTree(w.root);
    const r = await w.run(["--case", "hotload"]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/unverified/);
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
  });

  it.each([
    [["--with-revocation"]],
    [["--two-session"]],
    [["--with-revocation", "--two-session", "--max-inference", "3", "--acknowledge-budget"]],
    [["--with-revocation", "--max-inference", "3"]],
  ])("refuses a budget smaller than %j needs, or above 2 without acknowledgment", async (extra) => {
    const w = makeWorld();
    const r = await w.run(["--case", "hotload", "--authorize-real-root", ...extra]);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/--max-inference/);
    expect(w.lines()).toEqual([]);
  });

  it("refuses the real Scout home as --home", async () => {
    const w = makeWorld();
    w.scoutHome = join(w.home, ".scout");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(existsSync(w.scoutHome)).toBe(false);
  });
});

describe("hotload: acceptance runs", () => {
  it("passes when the skill added after turn 1 is listed and used natively in turn 2; revocation is refused; additions removed", async () => {
    const w = makeWorld("hotload-watch");
    let token;
    const atTurnEnd = [];
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--with-revocation", "--max-inference", "3", "--acknowledge-budget"], {
      hooks: {
        onStart: (c) => void (token = c.token),
        afterTurn: (n, c) => void atTurnEnd.push({ n, skillDir: existsSync(join(w.skillsRoot, c.name)), registered: Object.hasOwn(w.registry(), c.name) }),
      },
    });
    expect(r.code, r.text).toBe(0);
    const rep = r.report;
    expect(rep).toMatchObject({ case: "hotload", label: "acceptance", pass: true, gatePass: true, outcome: "hotload_pass", revocation: "refused", failures: [] });
    // The watched parent existed before the session; the proof skill only after turn 1.
    expect(atTurnEnd[0]).toEqual({ n: 1, skillDir: false, registered: true });
    expect(atTurnEnd[1]).toEqual({ n: 2, skillDir: true, registered: true });
    expect(rep.skill.writtenAfterTurn).toBe(1);
    expect(rep.init.skills).toEqual([]);
    expect(rep.init.plugins).toBe(1);
    expect(JSON.stringify(rep.init)).not.toContain("someone-elses-plugin");
    expect(rep.turns[0]).toMatchObject({ discovery: "not_listed", listedNames: [], otherToolUses: 0 });
    expect(rep.turns.every((t) => !("text" in t))).toBe(true);
    expect(rep.turns[1]).toMatchObject({ discovery: "listed", listedNames: [rep.name], skillSucceeded: true, readSucceeded: true, proofPhraseQuoted: true });
    expect(rep.turns[1].toolUses.map((t) => t.name)).toEqual([`Skill(${rep.name})`, `mcp__${rep.name}__read_resource`]);
    expect(rep).toMatchObject({ discovery: "listed", listedNames: [rep.name], mcpStatusAtInit: "connected", mcpToolsDeferred: false, toolSearch: { offered: true, uses: 0 } });
    expect(rep.invocation).toMatchObject({ skillInvoked: true, readSucceeded: true, proofPhraseQuoted: true });
    expect(rep.turns[2]).toMatchObject({ readCalled: true, readSucceeded: false, readRevoked: true, readError: "revoked", proofPhraseQuoted: false });
    expect(rep.registration).toMatchObject({ loadedAtStart: "connected", ownedAfterAdd: true, add: { ok: true, status: 0 } });
    expect(rep.registration.get.scope).toMatch(/^User config/);
    expect(rep.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "use_skill", "read_after_revocation"]);
    expect(rep.cleanup).toMatchObject({ ok: true, skillDir: "removed_at_revocation", registration: "removed", processesRemaining: 0, fixtureConnectionsAtEnd: 0, throwawayRemoved: true });
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expect(rep.cli.version).toBe("2.1.286");
    expect(rep.preflight.verdict).toBe("subscription");
    expect(rep.argv).toEqual(expect.arrayContaining(["--input-format", "--max-turns", "8", "Skill,ToolSearch"]));
    expect(rep.argv).not.toContain("--strict-mcp-config");
    expect(rep.sessionLimits).toEqual({
      tools: "Skill,ToolSearch",
      allowedTools: ["Skill", "ToolSearch", `mcp__${rep.name}__read_resource`, `mcp__${rep.name}__list_resources`],
      permissionMode: "dontAsk",
      settings: { disableAllHooks: true },
      settingSources: "user",
      maxTurns: 8,
    });
    expect(rep.notes.join("\n")).toMatch(/single headless multi-turn `claude -p .*stream-json` process standing in for an interactive session/);
    expect(rep.notes.join("\n")).toMatch(/loads every user-scope MCP server and plugin/);
    expect(rep.notes.join("\n")).toMatch(/One inference request is one turn/);
    expect(rep.notes.join("\n")).toMatch(/missing user skills root is refused/);
    expect(r.text).toContain("standing in for an interactive session");
    // Turn 2's prompt does not name the skill: the model has to find it.
    const t2 = w.lines().find((l) => l.turn === 2);
    expect(t2.prompt).not.toContain(rep.name);
    expect(t2.prompt).toContain("Skills seen:");
    expectClean(w, r, token);
  });

  it("reports skill_not_invoked when the session does not pick up the new skill", async () => {
    const w = makeWorld("hotload-static");
    let token;
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ pass: false, outcome: "skill_not_invoked", afterRestart: "not_run", discovery: "not_listed", listedNames: [] });
    expect(r.report.turns[1]).toMatchObject({ skillInvoked: false, readCalled: false, readError: "not_called" });
    expect(r.report.inferenceRequests).toHaveLength(2);
    expect(r.report.cleanup.ok).toBe(true);
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expectClean(w, r, token);
  });

  it("--two-session: hotload_requires_reload when a fresh session invokes it", async () => {
    const w = makeWorld("hotload-static");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "hotload_requires_reload", afterRestart: "hotload_pass" });
    expect(r.report.sessions).toHaveLength(2);
    expect(sessions(w)).toHaveLength(2);
    expect(r.report.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "use_skill", "use_skill_after_restart"]);
    expect(r.report.cleanup.ok).toBe(true);
  });

  it("--two-session: skill_never_loads when the fresh session fails too", async () => {
    const w = makeWorld("hotload-never");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"]);
    expect(r.report).toMatchObject({ outcome: "skill_never_loads", afterRestart: "skill_not_invoked" });
    expect(r.report.cleanup.ok).toBe(true);
  });

  it.each([
    ["mcp-ignore", "absent"],
    ["mcp-failed", "failed"],
  ])("%s: not timing, so mcp_not_loaded right after turn 1", async (mode, status) => {
    const w = makeWorld(mode);
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "mcp_not_loaded", mcpStatusAtInit: status, afterRestart: "not_run" });
    expect(r.report.registration.loadedAtStart).toBe(status);
    expect(r.report.inferenceRequests).toHaveLength(1);
    expect(r.report.skill).toBeUndefined();
    expect(r.report.cleanup).toMatchObject({ ok: true, skillDir: "not_created", registration: "removed" });
    expect(w.registry()).toEqual({});
  });

  it("pending at init, connected by turn 2: no early stop, no extra wait; turn 2 decides (pass)", async () => {
    const w = makeWorld("mcp-pending-then-connected");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ outcome: "hotload_pass", mcpStatusAtInit: "pending", registration: { loadedAtStart: "pending" } });
    expect(r.report.mcpToolsDeferred).toBeUndefined();
    expect(r.report.skill.settleMs).toBe(50);
    expect(r.report.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "use_skill"]);
    expect(r.text).toContain("proof MCP server at init: pending");
    expect(r.report.notes.join("\n")).toMatch(/non-blocking/);
    expect(r.report.cleanup.ok).toBe(true);
  });

  it("pending at init and never connected: turn 2's failed read labels it mcp_not_loaded (pending)", async () => {
    const w = makeWorld("mcp-pending-never");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "mcp_not_loaded", mcpStatusAtInit: "pending" });
    expect(r.report.turns[1]).toMatchObject({ skillInvoked: true, readCalled: true, readSucceeded: false, readError: "tool_unavailable" });
    expect(r.report.inferenceRequests).toHaveLength(2);
    expect(r.report.cleanup.ok).toBe(true);
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
  });

  it("--two-session: mcp_requires_restart only when a fresh session shows a failed server connected", async () => {
    const first = makeWorld("mcp-failed-first");
    const r = await first.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"]);
    expect(r.report).toMatchObject({ outcome: "mcp_requires_restart", mcpStatusAtInit: "failed", afterRestart: "mcp_connected" });
    expect(r.report.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "list_skills_after_restart"]);
    expect(r.report.cleanup.ok).toBe(true);

    const always = makeWorld("mcp-failed");
    const r2 = await always.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"]);
    expect(r2.report).toMatchObject({ outcome: "mcp_not_loaded", mcpStatusAtInit: "failed", afterRestart: "mcp_failed" });
  }, 30_000); // four fake sessions in a row; over 5 s on a slow Linux runner

  it.each([
    ["read-fail", { outcome: "skill_invoked_read_failed", readError: "not_found", readCalled: true }],
    ["skill-no-read", { outcome: "skill_invoked_read_failed", readError: "not_called", readCalled: false }],
    ["phrase-missing", { outcome: "read_ok_phrase_missing", readCalled: true }],
    ["not-listed", { outcome: "skill_used_not_listed", readCalled: true }],
  ])("%s: labelled by evidence", async (mode, want) => {
    const w = makeWorld(mode);
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code).toBe(1);
    expect(r.report.outcome).toBe(want.outcome);
    expect(r.report.turns[1]).toMatchObject({ skillInvoked: true, readCalled: want.readCalled, ...(want.readError ? { readError: want.readError } : {}) });
    expect(r.report.discovery).toBe(mode === "not-listed" ? "not_listed" : "listed");
    expect(r.report.cleanup.ok).toBe(true);
    expect(w.registry()).toEqual({});
  });

  it("deferred MCP tools: ToolSearch offered and used; still passes; recorded", async () => {
    const w = makeWorld("deferred");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ outcome: "hotload_pass", mcpToolsDeferred: true, toolSearch: { offered: true, uses: 1 } });
    expect(r.report.init.tools).not.toContain(`mcp__${r.report.name}__read_resource`);
    expect(r.report.turns[1].toolUses.map((t) => t.name)).toEqual([`Skill(${r.report.name})`, "ToolSearch", `mcp__${r.report.name}__read_resource`]);
    expect(r.text).toContain("tools not listed in init; ToolSearch offered");
  });

  it("stops before registering or launching when the preflight is not subscription", async () => {
    const w = makeWorld("auth-api-key");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "preflight_failed", inferenceRequests: [] });
    expect(r.report.preflight.verdict).toBe("ambiguous");
    expect(w.lines().filter((l) => l.subcommand || l.session)).toEqual([]);
    expect(existsSync(w.registryFile)).toBe(false);
  });

  it("records the env filtering, not env values", async () => {
    const w = makeWorld();
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.report.preflight.envFiltering.forwardedKeys).toEqual(expect.arrayContaining(["HOME", "PATH"]));
    expect(r.report.preflight.envFiltering.forwardedKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(r.report.preflight.envFiltering.droppedKeyCount).toBeGreaterThanOrEqual(3);
  });
});

describe("hotload: CLAUDE_CONFIG_DIR", () => {
  it("userSkillsRoot follows CLAUDE_CONFIG_DIR, else HOME/.claude", () => {
    expect(userSkillsRoot({ HOME: "/h" })).toBe("/h/.claude/skills");
    expect(userSkillsRoot({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/skills");
  });

  it("puts the skill and the registration in CLAUDE_CONFIG_DIR and leaves HOME's alone", async () => {
    const w = makeWorld("hotload-watch", { configDir: true });
    const homeRegistry = join(w.home, ".claude.json");
    const seen = [];
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
      hooks: {
        afterTurn: (n, c) =>
          void seen.push({
            n,
            inConfig: existsSync(join(w.skillsRoot, c.name, "SKILL.md")),
            inHome: existsSync(join(w.homeSkillsRoot, c.name)),
            registeredInConfig: Object.hasOwn(w.registry(), c.name),
            homeRegistry: existsSync(homeRegistry),
          }),
      },
    });
    expect(r.code, r.text).toBe(0);
    expect(seen[1]).toEqual({ n: 2, inConfig: true, inHome: false, registeredInConfig: true, homeRegistry: false });
    expect(r.report.skillsRoot).toBe(w.skillsRoot);
    expect(w.lines().filter((l) => l.subcommand).length).toBeGreaterThanOrEqual(4);
    expect(proofDirs(w)).toEqual([]);
    expect(readdirSync(w.homeSkillsRoot)).toEqual([]);
    expect(w.registry()).toEqual({});
    expect(existsSync(homeRegistry)).toBe(false);
  });
});

describe("hotload: ownership", () => {
  const nonce = () => "aaaaaaaaaa";

  it("refuses when a skill dir with the proof name already exists, and leaves it alone", async () => {
    const w = makeWorld();
    const dir = join(w.skillsRoot, "scout-proof-aaaaaaaaaa");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "the user's own");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { nonce });
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("skill_dir_exists");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("the user's own");
    expect(sessions(w)).toEqual([]);
    expect(r.report.inferenceRequests).toEqual([]);
  });

  it("refuses when a registration with the proof name already exists, and leaves it alone", async () => {
    const w = makeWorld();
    const theirs = { type: "stdio", command: "/bin/echo", args: ["theirs"], env: {} };
    writeFileSync(w.registryFile, JSON.stringify({ mcpServers: { "scout-proof-aaaaaaaaaa": theirs } }));
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { nonce });
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("registration_exists");
    expect(w.registry()).toEqual({ "scout-proof-aaaaaaaaaa": theirs });
    expect(sessions(w)).toEqual([]);
  });

  it.each([
    ["mcp-add-fail", { ok: false, status: 1, signal: null, timedOut: false }],
    ["mcp-add-hang", { ok: false, status: null, signal: "SIGKILL", timedOut: true }],
  ])("%s: an add that wrote the entry and then failed is still removed", async (mode, add) => {
    const w = makeWorld(mode);
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { mcpTimeoutMs: 1500 });
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("registration_failed");
    expect(r.report.registration.add).toEqual(add);
    expect(r.report.cleanup).toMatchObject({ ok: true, registration: "removed" });
    expect(w.registry()).toEqual({});
    expect(sessions(w)).toEqual([]);
  });

  it.each([
    ["mcp-get-hang", { status: null, signal: "SIGKILL", timedOut: true }],
    ["mcp-get-killed", { status: null, signal: "SIGKILL", timedOut: false }],
  ])("%s after add wrote the entry: state unknown, entry left alone, cleanup not ok", async (mode, exit) => {
    const w = makeWorld(mode);
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { mcpTimeoutMs: 1500 });
    expect(r.code).toBe(1);
    expect(r.report.registration.add).toMatchObject({ ok: true });
    expect(r.report.registration.get).toEqual({ exists: "unknown", exit });
    expect(r.report.failures).toEqual(expect.arrayContaining(["registration_failed", "cleanup_incomplete"]));
    expect(r.report.cleanup).toMatchObject({ ok: false, registration: "unknown_state", registrationExit: exit });
    expect(Object.keys(w.registry())).toEqual([r.report.name]);
    expect(w.lines().filter((l) => l.subcommand?.[1] === "remove")).toEqual([]);
    expect(sessions(w)).toEqual([]);
  });

  it("leaves a skill edited during the check and a registration changed during the check", async () => {
    const w = makeWorld();
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
      nonce,
      hooks: {
        afterTurn: (n, c) => {
          if (n !== 2) return;
          appendFileSync(join(w.skillsRoot, c.name, "SKILL.md"), "\nedited by someone else\n");
          const cfg = JSON.parse(readFileSync(w.registryFile, "utf8"));
          cfg.mcpServers[c.name].args.push("--changed");
          writeFileSync(w.registryFile, JSON.stringify(cfg));
        },
      },
    });
    expect(r.code).toBe(1);
    expect(r.report.outcome).toBe("hotload_pass");
    expect(r.report.cleanup).toMatchObject({ ok: false, skillDir: "left_modified", registration: "left_changed" });
    expect(r.report.failures).toContain("cleanup_incomplete");
    expect(readFileSync(join(w.skillsRoot, "scout-proof-aaaaaaaaaa", "SKILL.md"), "utf8")).toContain("edited by someone else");
    expect(Object.keys(w.registry())).toEqual(["scout-proof-aaaaaaaaaa"]);
  });
});

describe("hotload: abort", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("%s to the script process mid-turn: session stopped, both additions removed, report says aborted", async (sig) => {
    const w = makeWorld("hang-turn2");
    const run = w.spawnRun(["--case", "hotload", "--authorize-real-root"], { turnTimeoutMs: 60_000 });
    expect(await waitFor(() => w.lines().some((l) => l.turn === 2))).toBe(true);
    const name = proofDirs(w)[0];
    expect(name).toMatch(/^scout-proof-/);
    expect(Object.keys(w.registry())).toEqual([name]);
    const sessionPid = sessions(w)[0].pid;
    expect(alive(sessionPid)).toBe(true);

    run.child.kill(sig);
    const { code, signal, output } = await run.exited;
    expect(signal).toBeNull();
    expect(code, output).toBe(1);
    expect(output).toContain(`${sig}; stopping the check and cleaning up`);
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expect(alive(sessionPid)).toBe(false);
    const { report } = w.lastReport();
    expect(report).toMatchObject({ outcome: "aborted", pass: false, gatePass: false });
    expect(report.failures).toContain(`aborted_${sig}`);
    expect(report.cleanup).toMatchObject({ ok: true, skillDir: "removed", registration: "removed", processesRemaining: 0, throwawayRemoved: true });
    expect(report.turns[1]).toMatchObject({ purpose: "use_skill", completed: false });
  }, 30_000);

  it("an uncaught exception aborts the same way (in process); a second signal does not run cleanup twice", async () => {
    const w = makeWorld("hang-turn2");
    const signals = new EventEmitter();
    const done = w.run(["--case", "hotload", "--authorize-real-root"], { turnTimeoutMs: 60_000 }, signals);
    expect(await waitFor(() => w.lines().some((l) => l.turn === 2))).toBe(true);
    signals.emit("uncaughtException", new Error("boom"));
    signals.emit("SIGINT");
    const r = await done;
    expect(r.code).toBe(1);
    expect(r.text).toContain("SIGINT again; cleanup is already running");
    expect(r.report).toMatchObject({ outcome: "aborted" });
    expect(r.report.failures).toContain("aborted_uncaughtException_Error");
    expect(r.report.failures.filter((f) => f.startsWith("aborted_"))).toHaveLength(1);
    expect(w.lines().filter((l) => l.subcommand?.[1] === "remove")).toHaveLength(1);
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("uncaughtException")).toBe(0);
  }, 30_000);
});

describe("hotload: two-session abort", () => {
  it("an abort between a restart's close and the next open closes each session once and counts real processes", async () => {
    const w = makeWorld("hotload-static");
    const signals = new EventEmitter();
    const r = await w.run(
      ["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"],
      { hooks: { afterTurn: (n) => void (n === 2 && setTimeout(() => signals.emit("SIGINT"), 0)) } },
      signals,
    );
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "aborted" });
    expect(r.report.sessions).toHaveLength(1);
    expect(sessions(w)).toHaveLength(1);
    expect(r.report.sessions[0].close).toMatchObject({ processesRemaining: 0 });
    expect(r.report.sessions[0].close.closeFailed).toBeUndefined();
    expect(r.report.cleanup).toMatchObject({ ok: true, processesRemaining: 0, registration: "removed", skillDir: "removed" });
  }, 30_000);
});

describe("hotload: preliminary", () => {
  it("uses a throwaway project skills dir and --mcp-config; nothing installed; cannot pass the gate", async () => {
    const w = makeWorld("hotload-watch");
    const r = await w.run(["--case", "hotload", "--preliminary"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ label: "preliminary", outcome: "hotload_pass", pass: true, gatePass: false });
    expect(r.report.argv).toEqual(expect.arrayContaining(["--mcp-config", "user,project"]));
    expect(r.report.sessionLimits.settingSources).toBe("user,project");
    expect(r.text).toContain("counts for the Phase 1 gate: no");
    expect(existsSync(w.registryFile)).toBe(false);
    expect(proofDirs(w)).toEqual([]);
    expect(w.lines().filter((l) => l.subcommand)).toEqual([]);
  });
});

describe("hotload: turn analysis", () => {
  const name = "scout-proof-abcdefghij";
  const readTool = `mcp__${name}__read_resource`;
  const turn = (blocks, result = "done") => ({
    ms: 1,
    timedOut: false,
    exited: false,
    result: { type: "result", subtype: "success", result },
    events: blocks.map(([type, content]) => ({ type, message: { content } })),
  });

  it("reads the model's own listing from any assistant text, not only the final reply", () => {
    const a = analyzeTurn(
      turn([
        ["assistant", [{ type: "text", text: `**Skills seen:** ${name}, scout-proof-zzzzzzzzzz` }]],
        ["assistant", [{ type: "tool_use", id: "1", name: "Skill", input: { skill: name } }]],
        ["user", [{ type: "tool_result", tool_use_id: "1", content: "Launching skill" }]],
        ["assistant", [{ type: "tool_use", id: "2", name: readTool, input: {} }]],
        ["user", [{ type: "tool_result", tool_use_id: "2", content: [{ type: "text", text: "Scout {...}\nProof phrase: P-1" }] }]],
      ], "Proof phrase: P-1"),
      { name, readTool, proofPhrase: "P-1" },
    );
    expect(a).toMatchObject({ listingLineFound: true, listedNames: [name, "scout-proof-zzzzzzzzzz"], discovery: "listed", readSucceeded: true, proofPhraseQuoted: true });
    expect(a.readError).toBeUndefined();
    expect(classifyUse(a)).toBe("hotload_pass");
    expect(a).not.toHaveProperty("text");
  });

  it("classifies by evidence", () => {
    const base = { skillInvoked: true, readSucceeded: true, proofPhraseQuoted: true, discovery: "listed" };
    expect(classifyUse({ ...base, skillInvoked: false })).toBe("skill_not_invoked");
    expect(classifyUse({ ...base, readSucceeded: false })).toBe("skill_invoked_read_failed");
    expect(classifyUse({ ...base, proofPhraseQuoted: false })).toBe("read_ok_phrase_missing");
    expect(classifyUse({ ...base, discovery: "not_listed" })).toBe("skill_used_not_listed");
    expect(classifyUse(base)).toBe("hotload_pass");
  });

  it("names read errors by Scout's code, else a coarse class", () => {
    expect(readErrorCode("Scout revoked: the user revoked it")).toBe("revoked");
    expect(readErrorCode("Permission to use mcp__x__read_resource has been denied")).toBe("permission_denied");
    expect(readErrorCode("No such tool available: mcp__x")).toBe("tool_unavailable");
    expect(readErrorCode("MCP server scout-proof-x is not connected")).toBe("server_not_connected");
    expect(readErrorCode("boom")).toBe("tool_error");
    expect(listedSkillNames("no listing here")).toEqual({ lineFound: false, names: [] });
    expect(listedSkillNames("Skills seen: none")).toEqual({ lineFound: true, names: [] });
  });
});

describe("hotload: report privacy", () => {
  it("keeps no model text: a foreign skill or server named in replies or tool uses never reaches the report", async () => {
    const w = makeWorld("mentions-foreign");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report.outcome).toBe("hotload_pass");
    expect(r.reportText).not.toContain(FOREIGN_SKILL);
    expect(r.reportText).not.toContain(FOREIGN_SERVER);
    expect(r.report.turns[1].listedNames).toEqual([r.report.name]);
    expect(r.report.turns[1].otherToolUses).toBe(1);
    expect(r.report.turns[1].toolUses.map((t) => t.name)).toEqual([`Skill(${r.report.name})`, `mcp__${r.report.name}__read_resource`]);
    for (const t of r.report.turns) expect(t).not.toHaveProperty("text");
  });

  it("counts the user's own allow rules, never lists them", async () => {
    const w = makeWorld();
    writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)", "mcp__private-thing__x", "Read"] } }));
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.report.userAllowRules).toEqual({ count: 3, mcpCount: 1 });
    expect(r.reportText).not.toContain("private-thing");
    expect(r.reportText).not.toContain("git status");
    expect(r.report.notes.join("\n")).toMatch(/userAllowRules counts them/);
  });
});

describe("hotload: registry changes underneath the run", () => {
  const theirs = { type: "stdio", command: "/bin/echo", args: ["theirs"], env: {} };

  it("records counts only and no change when nothing else wrote", async () => {
    const w = makeWorld();
    writeFileSync(w.registryFile, JSON.stringify({ mcpServers: { "someone-elses-server": theirs } }));
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report.registry).toEqual({ before: 1, after: 1, reappeared: false, foreignChanged: false, recheck: "absent" });
    expect(r.reportText).not.toContain("someone-elses-server");
    expect(w.registry()).toEqual({ "someone-elses-server": theirs });
  });

  it("foreignChanged when another writer adds a server during the run", async () => {
    const w = makeWorld();
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
      hooks: {
        afterTurn: (n) => {
          if (n !== 1) return;
          const cfg = JSON.parse(readFileSync(w.registryFile, "utf8"));
          cfg.mcpServers["concurrent-session-server"] = theirs;
          writeFileSync(w.registryFile, JSON.stringify(cfg));
        },
      },
    });
    expect(r.report.registry).toMatchObject({ before: 0, after: 1, foreignChanged: true, reappeared: false });
    expect(r.reportText).not.toContain("concurrent-session-server");
  });

  it("reappeared when our entry comes back after removal: a failure", async () => {
    const w = makeWorld();
    let ours;
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
      hooks: {
        afterTurn: (n, c) => void (n === 1 && (ours = JSON.parse(readFileSync(w.registryFile, "utf8")).mcpServers[c.name])),
        afterCleanup: ({ name }) => writeFileSync(w.registryFile, JSON.stringify({ mcpServers: { [name]: ours } })),
      },
    });
    expect(r.code).toBe(1);
    expect(r.report.cleanup).toMatchObject({ ok: true, registration: "removed" });
    expect(r.report.registry).toMatchObject({ reappeared: true, recheck: "present", after: 1 });
    expect(r.report.failures).toContain("registration_reappeared");
  });
});

describe("hotload: cleanup step isolation", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)("an unreadable proof dir is reported, the registration is still removed, and the report is written", async () => {
    const w = makeWorld();
    let dir;
    try {
      const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
        hooks: { afterTurn: (n, c) => void (n === 2 && chmodSync((dir = join(w.skillsRoot, c.name)), 0o000)) },
      });
      expect(r.code).toBe(1);
      expect(r.report.outcome).toBe("hotload_pass");
      expect(r.report.cleanup).toMatchObject({ ok: false, skillDir: "error_EACCES", registration: "removed", throwawayRemoved: true, processesRemaining: 0 });
      expect(r.report.failures).toContain("cleanup_incomplete");
      expect(w.registry()).toEqual({});
    } finally {
      if (dir) chmodSync(dir, 0o700);
    }
  });

  it("a skill dir swapped for a symlink is left alone (left_symlink); the registration is still removed", async () => {
    const w = makeWorld();
    const moved = join(w.root, "moved-skill");
    let dir;
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], {
      hooks: {
        afterTurn: (n, c) => {
          if (n !== 2) return;
          dir = join(w.skillsRoot, c.name);
          renameSync(dir, moved);
          symlinkSync(moved, dir);
        },
      },
    });
    expect(r.code).toBe(1);
    expect(r.report).toBeDefined();
    expect(r.report.cleanup).toMatchObject({ ok: false, skillDir: "left_symlink", registration: "removed", throwawayRemoved: true });
    expect(r.report.failures).toContain("cleanup_incomplete");
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(moved, "SKILL.md"), "utf8")).toContain("scout-proof-");
    expect(w.registry()).toEqual({});
  });
});

describe("hotload: --two-session preflight", () => {
  it("runs the preflight again before the fresh session and opens none if it fails", async () => {
    const w = makeWorld("hotload-static");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"], {
      hooks: { afterTurn: (n) => void (n === 2 && w.setMode("auth-api-key")) },
    });
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("preflight_failed_before_restart");
    expect(r.report.preflight).toMatchObject({ verdict: "subscription", beforeRestart: { verdict: "ambiguous" } });
    expect(r.report.afterRestart).toBe("preflight_failed");
    expect(r.report.sessions).toHaveLength(1);
    expect(sessions(w)).toHaveLength(1);
    expect(r.report.inferenceRequests).toHaveLength(2);
    expect(r.report.cleanup.ok).toBe(true);
  });

  it("records a passing preflight before restart", async () => {
    const w = makeWorld("hotload-static");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3", "--acknowledge-budget"]);
    expect(r.report.preflight.beforeRestart).toMatchObject({ verdict: "subscription" });
  });
});

describe("hotload: turn 2 classification against the init state", () => {
  const usable = { usable: true };
  const notUsable = { usable: false };
  const a = (over) => ({ skillInvoked: true, readCalled: true, readSucceeded: false, readError: "tool_error", proofPhraseQuoted: false, discovery: "listed", ...over });

  it("labels mcp_not_loaded only when the server was not usable at init", () => {
    expect(classifyTurn2(a({ readError: "tool_unavailable" }), notUsable)).toBe("mcp_not_loaded");
    expect(classifyTurn2(a({ readError: "server_not_connected" }), notUsable)).toBe("mcp_not_loaded");
    expect(classifyTurn2(a({ readCalled: false, readError: "not_called" }), notUsable)).toBe("mcp_not_loaded");
    expect(classifyTurn2(a({ readCalled: false, readError: "not_called" }), usable)).toBe("skill_invoked_read_failed");
    expect(classifyTurn2(a({ readError: "tool_unavailable" }), usable)).toBe("skill_invoked_read_failed");
    expect(classifyTurn2(a({ readError: "not_found" }), notUsable)).toBe("skill_invoked_read_failed");
    expect(classifyTurn2(a({ skillInvoked: false, readCalled: false, readError: "not_called" }), notUsable)).toBe("skill_not_invoked");
  });

  it("proofServerState: pending and connected-without-tools are not usable", () => {
    const opts = { name: "scout-proof-x", readTool: "mcp__scout-proof-x__read_resource" };
    expect(proofServerState({ mcpServers: [{ name: "scout-proof-x", status: "pending" }], tools: [] }, opts)).toMatchObject({ usable: false, proceed: true, atInit: "pending" });
    expect(proofServerState({ mcpServers: [{ name: "scout-proof-x", status: "connected" }], tools: [] }, opts)).toMatchObject({ usable: false, proceed: true, atInit: "connected_without_tools" });
    expect(proofServerState({ mcpServers: [], tools: [] }, opts)).toMatchObject({ usable: false, proceed: false, atInit: "absent" });
  });
});
