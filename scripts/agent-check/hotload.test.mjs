// verify:agent --case hotload against the scripted fake CLI: no model, no real config.
// Every path is under a temp root; the "real" skills root and MCP registry are the temp
// HOME's.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds, makeWorld, SENTINELS, snapshotTree } from "./test-support.mjs";

afterEach(cleanupWorlds);

const proofDirs = (w) => readdirSync(w.skillsRoot).filter((n) => n.startsWith("scout-proof-"));
const sessions = (w) => w.lines().filter((l) => l.session);

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
    expect(r.text).toContain("inference requests: at most 2");
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
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
    [["--with-revocation", "--two-session", "--max-inference", "3"]],
  ])("refuses a budget smaller than %j needs", async (extra) => {
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
  it("passes when the skill added after turn 1 is used natively in turn 2; revocation is refused; additions removed", async () => {
    const w = makeWorld("hotload-watch");
    let token;
    const atTurnEnd = [];
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--with-revocation", "--max-inference", "3"], {
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
    expect(rep.turns[0].text).toBe("Skills: none");
    expect(rep.turns[1]).toMatchObject({ skillSucceeded: true, readSucceeded: true, proofPhraseQuoted: true });
    expect(rep.turns[1].toolUses.map((t) => t.name)).toEqual([`Skill(${rep.name})`, `mcp__${rep.name}__read_resource`]);
    expect(rep.turns[2]).toMatchObject({ readCalled: true, readSucceeded: false, readRevoked: true, proofPhraseQuoted: false });
    expect(rep.registration).toMatchObject({ loadedAtStart: "connected", ownedAfterAdd: true });
    expect(rep.registration.get.scope).toMatch(/^User config/);
    expect(rep.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "use_skill", "read_after_revocation"]);
    expect(rep.cleanup).toMatchObject({ ok: true, skillDir: "removed_at_revocation", registration: "removed", processesRemaining: 0, fixtureConnectionsAtEnd: 0, throwawayRemoved: true });
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expect(rep.cli.version).toBe("2.1.286");
    expect(rep.preflight.verdict).toBe("subscription");
    expect(rep.argv).toContain("--input-format");
    expect(rep.argv).not.toContain("--strict-mcp-config");
    expectClean(w, r, token);
  });

  it("reports hotload_requires_reload when the session does not pick up the new skill", async () => {
    const w = makeWorld("hotload-static");
    let token;
    const r = await w.run(["--case", "hotload", "--authorize-real-root"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ pass: false, outcome: "hotload_requires_reload", afterRestart: "not_run" });
    expect(r.report.turns[1]).toMatchObject({ skillInvoked: true, skillSucceeded: false, readCalled: false });
    expect(r.report.turns[1].text).toContain("can't find a skill");
    expect(r.report.inferenceRequests).toHaveLength(2);
    expect(r.report.cleanup.ok).toBe(true);
    expect(proofDirs(w)).toEqual([]);
    expect(w.registry()).toEqual({});
    expectClean(w, r, token);
  });

  it("--two-session shows the skill works after a restart (needs reload, not broken)", async () => {
    const w = makeWorld("hotload-static");
    const r = await w.run(["--case", "hotload", "--authorize-real-root", "--two-session", "--max-inference", "3"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "hotload_requires_reload", afterRestart: "works" });
    expect(r.report.sessions).toHaveLength(2);
    expect(sessions(w)).toHaveLength(2);
    expect(r.report.inferenceRequests.map((i) => i.purpose)).toEqual(["list_skills", "use_skill", "use_skill_after_restart"]);
    expect(r.report.cleanup.ok).toBe(true);
  });

  it("reports mcp_requires_restart after one request when the registration did not load", async () => {
    const w = makeWorld("mcp-ignore");
    const r = await w.run(["--case", "hotload", "--authorize-real-root"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "mcp_requires_restart" });
    expect(r.report.registration.loadedAtStart).toBe("absent");
    expect(r.report.inferenceRequests).toHaveLength(1);
    expect(r.report.skill).toBeUndefined();
    expect(r.report.cleanup).toMatchObject({ ok: true, skillDir: "not_created", registration: "removed" });
    expect(w.registry()).toEqual({});
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

describe("hotload: preliminary", () => {
  it("uses a throwaway project skills dir and --mcp-config; nothing installed; cannot pass the gate", async () => {
    const w = makeWorld("hotload-watch");
    const r = await w.run(["--case", "hotload", "--preliminary"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ label: "preliminary", outcome: "hotload_pass", pass: true, gatePass: false });
    expect(r.report.argv).toEqual(expect.arrayContaining(["--mcp-config", "user,project"]));
    expect(r.text).toContain("counts for the Phase 1 gate: no");
    expect(existsSync(w.registryFile)).toBe(false);
    expect(proofDirs(w)).toEqual([]);
    expect(w.lines().filter((l) => l.subcommand)).toEqual([]);
  });
});
