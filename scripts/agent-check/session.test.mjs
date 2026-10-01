// startSession against the scripted fake CLI: a timed-out turn poisons the session.

import { afterEach, describe, expect, it } from "vitest";
import { SessionPoisoned, startSession } from "./session.mjs";
import { cleanupWorlds, makeWorld } from "./test-support.mjs";

afterEach(cleanupWorlds);

const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "Skill,ToolSearch", "--setting-sources", "user"];

describe("session", () => {
  it("refuses every send after a turn times out", async () => {
    const w = makeWorld("hang-turn2");
    const s = startSession({ claudePath: w.claude, args: ARGS, cwd: w.root, env: w.env, killGraceMs: 300 });
    try {
      const t1 = await s.send("list", { timeoutMs: 15_000 });
      expect(t1.timedOut).toBe(false);
      expect(t1.result?.type).toBe("result");
      expect(s.poisoned).toBe(false);
      const t2 = await s.send("list again", { timeoutMs: 300 });
      expect(t2.timedOut).toBe(true);
      expect(s.poisoned).toBe(true);
      await expect(s.send("third", { timeoutMs: 1000 })).rejects.toBeInstanceOf(SessionPoisoned);
      expect(w.lines().filter((l) => l.turn).map((l) => l.turn)).toEqual([1, 2]);
    } finally {
      await s.close();
    }
  }, 30_000);
});
