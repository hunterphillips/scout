// Which agent adapter runs a profile's jobs, and its default profile. Every adapter id the
// profile union knows (profile.ts) has a case here; the switch is exhaustive, so a new union
// member does not compile until it does.
//
// Readiness checks outlive adapters: the core builds a new adapter on every profile edit, but an
// adapter's check (Claude Code's billing preflight, run in a killable child process) keeps its
// cache and its running children across them. `createReadinessChecks` holds that per-adapter
// state for the core's lifetime, creates each adapter's part only when one is first built, and
// `cancelAll()` stops every check synchronously at shutdown.

import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { AgentJobAdapter } from "./adapter.js";
import type { Env } from "./authPreflight.js";
import { createClaudeJobAdapter } from "./claudeJob.js";
import { createDefaultClaudeCodeProfile } from "./claudeCode/profile.js";
import { createPreflightFacade, type PreflightFacade } from "./preflightWorker.js";
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

  claudeCode(): PreflightFacade {
    if (this.#claudeCode === undefined) {
      this.#claudeCode = createPreflightFacade();
      if (this.#closed) this.#claudeCode.cancelAll();
    }
    return this.#claudeCode;
  }

  cancelAll(): void {
    this.#closed = true;
    this.#claudeCode?.cancelAll();
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
}

export function createJobAdapter(profile: AgentProfile, deps: AdapterFactoryDeps): AgentJobAdapter {
  const { readinessChecks, ...rest } = deps;
  const checks = readinessChecks instanceof AdapterReadinessChecks ? readinessChecks : undefined;
  switch (profile.adapter) {
    case "claude-code":
      return createClaudeJobAdapter({ ...rest, profile, ...(checks ? { preflightAsync: checks.claudeCode() } : {}) });
  }
}

/** The initial profile, for the default adapter (Claude Code). */
export function createDefaultAgentProfile(parentEnv: Env): AgentProfile {
  return createDefaultClaudeCodeProfile(parentEnv);
}
