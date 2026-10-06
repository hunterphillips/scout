// The side panel's agent choice (`set_agent`, and the `agents` field of the capabilities frame).
//
// - `agentChoices`: one option per adapter whose executable is found on the core's PATH (the
//   registry's `createDefaultProfileFor` succeeds), plus the current profile's adapter while its
//   recorded executable exists, and the adapter `agent-profile.json` names now. Read from disk on
//   every call, so an install or a hand edit shows on the next frame.
// - `switchAgent`: writes the registry's default profile for the chosen adapter, keeping the
//   current profile's `tools`. Naming the adapter the profile already names writes nothing (a
//   retry, or a click on the selected option, never resets an edited model). The core's profile
//   watcher (wiring/profileWatcher.ts via wiring/jobs.ts) notices the write and swaps the adapter;
//   nothing here touches the running adapter. The caller holds `agent-profile.lock`.

import type { AckFailureCode, PanelAgents } from "@scout/contracts";
import type { Env } from "./executables.js";
import { isExecutableFile } from "./executables.js";
import { AGENT_ADAPTER_IDS, AgentProfileError, loadAgentProfile, writeAgentProfile, type AgentProfile } from "./profile.js";
import { adapterLabel, createDefaultProfileFor, profileExecutable } from "./registry.js";

export type AgentAdapterId = AgentProfile["adapter"];

export type SwitchAgentOutcome =
  | { ok: true; written: boolean }
  | { ok: false; code: Extract<AckFailureCode, "invalid" | "not_found" | "store_error" | "unavailable"> };

const isAdapterId = (id: string): id is AgentAdapterId => (AGENT_ADAPTER_IDS as readonly string[]).includes(id);

function currentProfile(home: string): AgentProfile | null {
  try {
    return loadAgentProfile(home);
  } catch {
    return null;
  }
}

/** Whether the adapter's executable can be found for a new profile. */
function found(id: AgentAdapterId, env: Env): boolean {
  try {
    createDefaultProfileFor(id, env);
    return true;
  } catch {
    return false;
  }
}

/** The options Settings offers and the adapter the profile names now. */
export function agentChoices(home: string, env: Env): PanelAgents {
  const current = currentProfile(home);
  const available = AGENT_ADAPTER_IDS.filter(
    (id) => found(id, env) || (current?.adapter === id && isExecutableFile(profileExecutable(current))),
  ).map((id) => ({ id, label: adapterLabel(id) }));
  return { available, ...(current ? { current: current.adapter } : {}) };
}

/** Make `id` the adapter background jobs run through. */
export function switchAgent(home: string, id: string, env: Env): SwitchAgentOutcome {
  if (!isAdapterId(id)) return { ok: false, code: "invalid" };
  const current = currentProfile(home);
  if (current?.adapter === id) return { ok: true, written: false };
  let next: AgentProfile;
  try {
    next = createDefaultProfileFor(id, env);
  } catch (e) {
    return { ok: false, code: e instanceof AgentProfileError ? "not_found" : "store_error" };
  }
  if (current?.tools) next = { ...next, tools: current.tools };
  try {
    writeAgentProfile(home, next);
  } catch {
    return { ok: false, code: "store_error" };
  }
  return { ok: true, written: true };
}
