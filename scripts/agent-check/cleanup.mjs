// The hot-load check's one cleanup, as a standalone function over a state object. Every step
// runs even when an earlier one throws: sessions, skill dir, registration, fixture, launch
// profile, throwaway dir. A step that throws records a fixed code (`error_<errno or name>`)
// in its own field and the rest still run. The registration step runs whatever the skill
// step returned. cleanup.ok is true only if every step ended in a clean state.

import { errorCode } from "./classify.mjs";
import { pathExists, removeOwnedSkill } from "./registration.mjs";

export const SKILL_DIR_OK = Object.freeze(["removed", "removed_at_revocation", "not_created"]);
export const REGISTRATION_OK = Object.freeze(["removed", "not_registered", "none (mcp-config file)"]);

/**
 * @param {object} s
 *   label            "acceptance" | "preliminary" | undefined
 *   sessions         report entries, one per session (each gets `.close`)
 *   closeSession     async (i) => void; records sessions[i].close
 *   skill            { dir, hash, removedAtRevocation? } | undefined
 *   addAttempted, registered   booleans
 *   removeRegistration  () => { state, exit? }  (acceptance only)
 *   fixture          { openConnections(), close() } | undefined
 *   profile          { cleanup() } | undefined
 *   throwaway        { root, remove() }
 *   cleanup          the report object to fill
 *   failures         the run's failure list
 *   removeSkill      optional seam, default removeOwnedSkill
 *   connectionWaitMs optional, default 1000
 */
export async function runCleanup(s) {
  const c = s.cleanup;
  const removeSkill = s.removeSkill ?? removeOwnedSkill;

  for (let i = 0; i < s.sessions.length; i++) {
    try {
      await s.closeSession(i);
    } catch (e) {
      s.sessions[i].close = { closeFailed: true, error: errorCode(e), processesRemaining: null };
    }
  }

  try {
    c.skillDir = s.skill ? removeSkill(s.skill.dir, s.skill.hash) : "not_created";
    if (s.skill?.removedAtRevocation === "removed" && c.skillDir === "absent") c.skillDir = "removed_at_revocation";
  } catch (e) {
    c.skillDir = errorCode(e);
  }

  try {
    if (s.label === "acceptance" && s.addAttempted) {
      // Whatever `add` reported: it may have written the entry and then failed or timed out.
      const rm = s.removeRegistration();
      c.registration = rm.state === "absent" && !s.registered ? "not_registered" : rm.state;
      if (rm.exit) c.registrationExit = rm.exit;
    } else c.registration = s.label === "acceptance" ? "not_registered" : "none (mcp-config file)";
  } catch (e) {
    c.registration = errorCode(e);
  }

  const counts = s.sessions.map((x) => x.close?.processesRemaining);
  const proc = counts.some((n) => typeof n !== "number") ? null : counts.reduce((a, b) => a + b, 0);

  if (s.fixture) {
    try {
      const until = Date.now() + (s.connectionWaitMs ?? 1000);
      while (s.fixture.openConnections() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      c.fixtureConnectionsAtEnd = s.fixture.openConnections();
      await s.fixture.close();
      c.fixture = "closed";
    } catch (e) {
      c.fixture = errorCode(e);
    }
  } else c.fixture = "not_started";

  try {
    s.profile?.cleanup();
  } catch (e) {
    c.profileCleanup = errorCode(e);
  }

  try {
    s.throwaway.remove();
  } catch (e) {
    c.throwawayError = errorCode(e);
  }
  c.processesRemaining = proc;
  c.throwawayRemoved = !pathExists(s.throwaway.root);
  c.ok =
    SKILL_DIR_OK.includes(c.skillDir) &&
    REGISTRATION_OK.includes(c.registration) &&
    proc === 0 &&
    c.fixture !== undefined &&
    !c.fixture.startsWith("error_") &&
    c.profileCleanup === undefined &&
    c.throwawayRemoved;
  if (!c.ok) s.failures.push("cleanup_incomplete");
  return c;
}
