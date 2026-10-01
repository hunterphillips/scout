// Watches a running job's stream-json events and stops the job the moment one shows a
// misconfiguration. Rules, in order, for each event (nothing counts after a stop):
//   - any `system` event whose subtype starts with `hook`: a user hook ran
//     (unsupported_configuration, `hook_ran`);
//   - anything but `system` or `result` before init: malformed_startup;
//   - a second init: malformed_startup, `second_init`;
//   - the init event must pass checkInit (initCheck.ts); it fills the job's model, CLI
//     version and optional-tool status;
//   - an assistant `tool_use` must name an allowed tool or the structured-output tool
//     (`unexpected_tool_use`); names are recorded, bounded;
//   - the first `result` event is kept;
//   - a non-result event that reports an auth or quota problem: unavailable, auth_or_quota.
//
// Adapted from the legacy agentRunner's event handler; isAuthOrQuota is verbatim.

import type { Clock } from "../clock.js";
import type { JobDetails, JobTermination } from "./adapter.js";
import { checkInit, type ExpectedInit } from "./initCheck.js";
import { STRUCTURED_OUTPUT_TOOL } from "./jobSurface.js";
import type { JobStop } from "./jobStop.js";
import { isRecord, type StreamRecord } from "./jsonLineStream.js";

const MAX_TOOL_USES_RECORDED = 64;

// Verbatim from the legacy agentRunner.
const AUTH_QUOTA_STATUS = [401, 403, 429];
const AUTH_QUOTA_TEXT = /(\/login|log ?in|auth|api key|rate.?limit|usage limit|quota|credit|billing|overloaded)/i;
export function isAuthOrQuota(ev: StreamRecord): boolean {
  if (ev.type === "system" && ev.subtype === "api_retry") {
    return AUTH_QUOTA_STATUS.includes(ev.error_status as number) || /auth|rate_limit|billing/i.test(String(ev.error ?? ""));
  }
  if (ev.type === "result" && ev.is_error === true) {
    return AUTH_QUOTA_STATUS.includes(ev.api_error_status as number) || AUTH_QUOTA_TEXT.test(String(ev.result ?? ""));
  }
  return false;
}

export interface StreamMonitorOptions {
  expected: ExpectedInit;
  allowedTools: ReadonlySet<string>;
  details: JobDetails;
  stop: JobStop;
  clock: Clock;
  /** When the CLI was spawned, on `clock`. */
  startedAt: number;
}

export interface StreamMonitor {
  onEvent(ev: StreamRecord): void;
  readonly init: StreamRecord | undefined;
  readonly result: StreamRecord | undefined;
}

export function createStreamMonitor(o: StreamMonitorOptions): StreamMonitor {
  const { expected, details, stop } = o;
  let init: StreamRecord | undefined;
  let result: StreamRecord | undefined;
  const unsupported = (detail: string): void => stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail });

  const onEvent = (ev: StreamRecord): void => {
    if (stop.decision !== undefined) return; // nothing after a stop counts, a late result least of all
    if (ev.type === "system" && typeof ev.subtype === "string" && ev.subtype.startsWith("hook")) return unsupported("hook_ran");
    if (init === undefined && ev.type !== "system" && ev.type !== "result") return stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup" });
    if (ev.type === "system" && ev.subtype === "init") {
      if (init !== undefined) return stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "second_init" });
      init = ev;
      details.timings.initMs = o.clock.now() - o.startedAt;
      const check = checkInit(ev, expected);
      if (!check.ok) {
        const termination: JobTermination = check.reason === "tool_unavailable" ? "tool_unavailable" : check.reason === "preflight_failed" ? "preflight_failed" : "unsupported_configuration";
        return stop.halt({ result: { status: "error", reason: check.reason }, termination, detail: check.detail });
      }
      details.model = check.model;
      if (check.cliVersion !== undefined) details.cliVersion = check.cliVersion;
      details.optionalTools = expected.servers.filter((s) => !s.required).map((s) => ({ server: s.name, status: check.optionalUnavailable.includes(s.name) ? "unavailable" : "available" }));
    } else if (ev.type === "assistant") {
      const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of content) {
        if (!isRecord(c) || c.type !== "tool_use") continue;
        const name = typeof c.name === "string" ? c.name : "";
        if (details.toolUses.length < MAX_TOOL_USES_RECORDED && /^[A-Za-z0-9_-]{1,128}$/.test(name)) details.toolUses.push(name);
        if (name !== STRUCTURED_OUTPUT_TOOL && !o.allowedTools.has(name)) return unsupported("unexpected_tool_use");
      }
    } else if (ev.type === "result" && result === undefined) {
      result = ev;
      stop.resultArrived();
    }
    if (ev.type !== "result" && isAuthOrQuota(ev)) stop.halt({ result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota" });
  };

  return {
    onEvent,
    get init() {
      return init;
    },
    get result() {
      return result;
    },
  };
}
