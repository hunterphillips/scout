// Who is calling on agent.sock. A connection's first frame is `hello` with a token, which
// is one of:
// - the interactive token: 32 random bytes (base64url), new on every core start, written
//   atomically to <scoutHome>/run/agent-token (0600) for Scout's MCP adapter to read, and
//   removed on shutdown. Role `interactive`.
// - a job token: 32 random bytes, issued in memory for one background job (the snapshot
//   registry, activity/snapshots.ts, issues them). Role `job`. It expires at the job's
//   deadline on the injected clock, and is invalidated by `revokeJobToken` (the job ended,
//   was cancelled, or its snapshot was released), by `revokeJobTokensPinning` (a resource
//   its snapshot pinned was revoked), and by `revokeAllJobTokens` (pause, shutdown).
//   `isCurrent` is checked on every call, so an invalidated token's already-connected
//   adapter is refused on its next read.
// Tokens are compared in constant time and never logged, echoed, or written anywhere else.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "../clock.js";
import { ensurePrivateRunDir, unlinkIfSameInode } from "../localSocketFiles.js";

export const AGENT_TOKEN_FILE = "agent-token";

export interface AgentPrincipal {
  readonly role: "interactive" | "job";
  /** Stable for the token's lifetime; cursors are bound to it. Never the secret. */
  readonly tokenId: string;
  /** Role `job` only: the job the token was issued for, which names its snapshot. */
  readonly jobId?: string;
  /** Role `job` only: the job's site, as its `current_site`. */
  readonly origin?: string;
  /** Role `job` only: the visit the job was created for. */
  readonly visitEpoch?: number;
}

export interface JobTokenGrant {
  jobId: string;
  /** Resources the job's snapshot pinned; revoking any of them invalidates the token. */
  resourceIds: readonly string[];
  /** The job's deadline on the auth clock; the token is refused from then on. */
  expiresAt: number;
  /** The job's site origin and visit, served as its `current_site`. */
  origin?: string;
  visitEpoch?: number;
}

export interface AgentAuth {
  /** The principal a hello token names, or null. */
  verify(token: string): AgentPrincipal | null;
  /** False once the principal's token has been revoked; checked on every call. */
  isCurrent(principal: AgentPrincipal): boolean;
  /** A new random token for `grant.jobId`. Throws when that job already holds a live token. */
  issueJobToken(grant: JobTokenGrant): string;
  /** Invalidate the job's token (cancellation, job end, snapshot release). Idempotent. */
  revokeJobToken(jobId: string): void;
  /** Revoke every job token whose snapshot pinned `resourceId`. Synchronous and idempotent. */
  revokeJobTokensPinning(resourceId: string): void;
  /** Revoke every job token (pause, shutdown). Synchronous and idempotent. */
  revokeAllJobTokens(): void;
}

export const newAgentToken = (): string => randomBytes(32).toString("base64url");

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
/** Constant time in the secret: both sides are hashed to a fixed length first. */
const sameToken = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const INTERACTIVE: AgentPrincipal = Object.freeze({ role: "interactive", tokenId: "interactive" });

export function createAgentAuth(options: { interactiveToken: string; clock?: Clock }): AgentAuth {
  const clock = options.clock ?? systemClock;
  const jobs = new Map<string, { token: string; resourceIds: ReadonlySet<string>; expiresAt: number; principal: AgentPrincipal }>();
  /** Forget every job token past its deadline. */
  const dropExpired = (): void => {
    const now = clock.now();
    for (const [jobId, job] of jobs) if (job.expiresAt <= now) jobs.delete(jobId);
  };
  return {
    verify(token) {
      if (sameToken(token, options.interactiveToken)) return INTERACTIVE;
      dropExpired();
      let found: AgentPrincipal | null = null;
      // Compare against every entry so the time taken does not depend on which one matched.
      for (const job of jobs.values()) if (sameToken(token, job.token)) found = job.principal;
      return found;
    },
    isCurrent(principal) {
      if (principal === INTERACTIVE) return true;
      dropExpired();
      for (const job of jobs.values()) if (job.principal === principal) return true;
      return false;
    },
    issueJobToken(grant) {
      dropExpired();
      if (jobs.has(grant.jobId)) throw new Error("scout: job already holds a token");
      const token = newAgentToken();
      jobs.set(grant.jobId, {
        token,
        resourceIds: new Set(grant.resourceIds),
        expiresAt: grant.expiresAt,
        principal: Object.freeze({
          role: "job",
          tokenId: `job:${randomBytes(8).toString("hex")}`,
          jobId: grant.jobId,
          ...(grant.origin !== undefined ? { origin: grant.origin } : {}),
          ...(grant.visitEpoch !== undefined ? { visitEpoch: grant.visitEpoch } : {}),
        }),
      });
      return token;
    },
    revokeJobToken: (jobId) => void jobs.delete(jobId),
    revokeJobTokensPinning(resourceId) {
      for (const [jobId, job] of jobs) if (job.resourceIds.has(resourceId)) jobs.delete(jobId);
    },
    revokeAllJobTokens: () => jobs.clear(),
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
