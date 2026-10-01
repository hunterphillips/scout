// Who is calling on agent.sock. A connection's first frame is `hello` with a token, which
// is one of:
// - the interactive token: 32 random bytes (base64url), new on every core start, written
//   atomically to <scoutHome>/run/agent-token (0600) for Scout's MCP adapter to read, and
//   removed on shutdown. Role `interactive`.
// - a job token, issued in memory for one background job and revoked when the job ends or a
//   resource its snapshot pinned is revoked. Role `job`. Phase 3 issues them; until then the
//   table is empty and every job token is refused.
// Tokens are compared in constant time and never logged, echoed, or written anywhere else.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateRunDir, unlinkIfSameInode } from "../localSocketFiles.js";

export const AGENT_TOKEN_FILE = "agent-token";

export interface AgentPrincipal {
  readonly role: "interactive" | "job";
  /** Stable for the token's lifetime; cursors are bound to it. Never the secret. */
  readonly tokenId: string;
}

export interface JobTokenGrant {
  jobId: string;
  /** Resources the job's snapshot pinned; revoking any of them invalidates the token. */
  resourceIds: readonly string[];
}

export interface AgentAuth {
  /** The principal a hello token names, or null. */
  verify(token: string): AgentPrincipal | null;
  /** False once the principal's token has been revoked; checked on every call. */
  isCurrent(principal: AgentPrincipal): boolean;
  issueJobToken(grant: JobTokenGrant): string;
  revokeJobToken(jobId: string): void;
  /** Revoke every job token whose snapshot pinned `resourceId`. Synchronous and idempotent. */
  revokeJobTokensPinning(resourceId: string): void;
}

export const newAgentToken = (): string => randomBytes(32).toString("base64url");

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
/** Constant time in the secret: both sides are hashed to a fixed length first. */
const sameToken = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const INTERACTIVE: AgentPrincipal = Object.freeze({ role: "interactive", tokenId: "interactive" });

export function createAgentAuth(options: { interactiveToken: string }): AgentAuth {
  const jobs = new Map<string, { token: string; resourceIds: ReadonlySet<string>; principal: AgentPrincipal }>();
  return {
    verify(token) {
      if (sameToken(token, options.interactiveToken)) return INTERACTIVE;
      let found: AgentPrincipal | null = null;
      // Compare against every entry so the time taken does not depend on which one matched.
      for (const job of jobs.values()) if (sameToken(token, job.token)) found = job.principal;
      return found;
    },
    isCurrent(principal) {
      if (principal === INTERACTIVE) return true;
      for (const job of jobs.values()) if (job.principal === principal) return true;
      return false;
    },
    issueJobToken(grant) {
      const token = newAgentToken();
      jobs.set(grant.jobId, {
        token,
        resourceIds: new Set(grant.resourceIds),
        principal: Object.freeze({ role: "job", tokenId: `job:${randomBytes(8).toString("hex")}` }),
      });
      return token;
    },
    revokeJobToken: (jobId) => void jobs.delete(jobId),
    revokeJobTokensPinning(resourceId) {
      for (const [jobId, job] of jobs) if (job.resourceIds.has(resourceId)) jobs.delete(jobId);
    },
  };
}

export interface InteractiveTokenFile {
  readonly token: string;
  readonly path: string;
  /** Remove the file if it is still the one written here. Idempotent. */
  remove(): void;
}

/**
 * Write a fresh interactive token to <runDir>/agent-token: a 0600 temp file created
 * exclusively, fsynced, then renamed over any previous token, so a reader sees the old file
 * or the new one, never a partial or wider-mode one.
 */
export function writeInteractiveTokenFile(runDir: string): InteractiveTokenFile {
  ensurePrivateRunDir(runDir);
  const token = newAgentToken();
  const path = join(runDir, AGENT_TOKEN_FILE);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(temp);
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (e) {
    unlinkSync(temp);
    throw e;
  }
  const ino = lstatSync(path).ino;
  let removed = false;
  return {
    token,
    path,
    remove() {
      if (removed) return;
      removed = true;
      unlinkIfSameInode(path, ino);
    },
  };
}
