// Which agent adapter runs a profile's jobs, and its default profile. Every adapter id the
// profile union knows (profile.ts) has a case here; the switch is exhaustive, so a new union
// member does not compile until it does.
//
// Readiness checks outlive adapters: the core builds a new adapter on every profile edit, but an
// adapter's check (Claude Code's billing preflight, Codex's login check, each run in a killable
// child process) keeps its cache and its running children across them. `createReadinessChecks` holds that per-adapter
// state for the core's lifetime, creates each adapter's part only when one is first built, and
// `cancelAll()` stops every check synchronously at shutdown.

import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { AgentJobAdapter } from "./adapter.js";
import type { Env, ExecutableSearch } from "./executables.js";
import { createClaudeJobAdapter, type ClaudeJobDeps } from "./claudeCode/claudeJob.js";
import { CLAUDE_CODE_LABEL, createDefaultClaudeCodeProfile, findExecutable as findClaudeExecutable } from "./claudeCode/profile.js";
import { createPreflightFacade, type PreflightFacade } from "./claudeCode/preflightWorker.js";
import { createCodexJobAdapter, type CodexJobDeps } from "./codex/codexJob.js";
import { CODEX_LABEL, createDefaultCodexProfile, findExecutable as findCodexExecutable } from "./codex/profile.js";
import { createCodexReadinessFacade, type CodexReadinessFacade } from "./codex/readinessWorker.js";
import type { ProcessTracker } from "./processTree.js";
import type { AgentProfile } from "./profile.js";

/** Long-lived readiness state shared by every adapter built from it. */
export interface ReadinessChecks {
  /** Stop every running check now and start none from now on. Synchronous. */
  cancelAll(): void;
}

class AdapterReadinessChecks implements ReadinessChecks {
  #closed = false;
  #claudeCode: PreflightFacade | undefined;
  #codex: CodexReadinessFacade | undefined;

  claudeCode(): PreflightFacade {
    if (this.#claudeCode === undefined) {
      this.#claudeCode = createPreflightFacade();
      if (this.#closed) this.#claudeCode.cancelAll();
    }
    return this.#claudeCode;
  }

  codex(): CodexReadinessFacade {
    if (this.#codex === undefined) {
      this.#codex = createCodexReadinessFacade();
      if (this.#closed) this.#codex.cancelAll();
    }
    return this.#codex;
  }

  cancelAll(): void {
    this.#closed = true;
    this.#claudeCode?.cancelAll();
    this.#codex?.cancelAll();
  }
}

export function createReadinessChecks(): ReadinessChecks {
  return new AdapterReadinessChecks();
}

export interface AdapterFactoryDeps {
  /** SCOUT_HOME. */
  home: string;
  /** The core's environment; the adapter picks what its agent needs from it. */
  parentEnv: Env;
  /** Shared across the adapters the core builds; without it, an adapter runs its checks in-process. */
  readinessChecks?: ReadinessChecks;
  clock?: Clock;
  diagnostics?: Diagnostics;
  processTracker?: ProcessTracker;
  /**
   * Extra options for whichever adapter the profile names, keyed by adapter id. The compatibility
   * checks (scripts/agent-check) pass their spawn observer and hermetic readiness seams here; the
   * core passes none.
   */
  seams?: AdapterSeams;
}

type SeamsOf<D> = Partial<Omit<D, "home" | "profile" | "parentEnv">>;
export interface AdapterSeams {
  "claude-code"?: SeamsOf<ClaudeJobDeps>;
  codex?: SeamsOf<CodexJobDeps>;
}

export function createJobAdapter(profile: AgentProfile, deps: AdapterFactoryDeps): AgentJobAdapter {
  const { readinessChecks, seams, ...rest } = deps;
  const checks = readinessChecks instanceof AdapterReadinessChecks ? readinessChecks : undefined;
  switch (profile.adapter) {
    case "claude-code":
      return createClaudeJobAdapter({ ...rest, profile, ...(checks ? { preflightAsync: checks.claudeCode() } : {}), ...seams?.["claude-code"] });
    case "codex":
      return createCodexJobAdapter({ ...rest, profile, ...(checks ? { readinessAsync: checks.codex() } : {}), ...seams?.codex });
  }
}

/** The initial profile, for the default adapter (Claude Code). */
export function createDefaultAgentProfile(parentEnv: Env): AgentProfile {
  return createDefaultClaudeCodeProfile(parentEnv);
}

/**
 * The initial profile for a named adapter; throws AgentProfileError when its executable is found
 * neither on PATH nor in the adapter's fallback locations.
 */
export function createDefaultProfileFor(id: AgentProfile["adapter"], parentEnv: Env, search: ExecutableSearch = {}): AgentProfile {
  switch (id) {
    case "claude-code":
      return createDefaultClaudeCodeProfile(parentEnv, search);
    case "codex":
      return createDefaultCodexProfile(parentEnv, search);
  }
}

/** The adapter's executable as a new profile would record it (PATH, then its fallbacks), or undefined. */
export function findAdapterExecutable(id: AgentProfile["adapter"], parentEnv: Env, search: ExecutableSearch = {}): string | undefined {
  switch (id) {
    case "claude-code":
      return findClaudeExecutable(parentEnv, search);
    case "codex":
      return findCodexExecutable(parentEnv, search);
  }
}

/** The adapter's name as the side panel shows it. */
export function adapterLabel(id: AgentProfile["adapter"]): string {
  switch (id) {
    case "claude-code":
      return CLAUDE_CODE_LABEL;
    case "codex":
      return CODEX_LABEL;
  }
}

/** The absolute executable a profile's jobs run. */
export function profileExecutable(profile: AgentProfile): string {
  switch (profile.adapter) {
    case "claude-code":
      return profile.claudePath;
    case "codex":
      return profile.codexPath;
  }
}
