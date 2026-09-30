// The run budget across all source tools: at most `maxCalls` calls and `maxTotalBytes`
// returned. Every call counts, refused ones included.
//
// Bytes are counted once per result, on its compact JSON text, although the MCP result
// carries the same object twice (as text and as structuredContent). The budget protects
// the model's context, and the model sees one copy.
//
// Two ways a result can be refused for size:
// - on its own it is over `maxCallBytes`: that call alone is refused (`too-large`) and
//   the run goes on, so one hostile page or note can't end every later tool;
// - it fits `maxCallBytes` but the run's committed bytes plus it would pass
//   `maxTotalBytes`: the budget is exhausted, and from then on every call returns
//   `budget_exhausted`, whatever its size.
// The call past `maxCalls` exhausts the budget the same way.

export interface RunBudgetLimits {
  maxCalls: number;
  maxTotalBytes: number;
  /** Largest single result. Defaults to min(32 KiB, maxTotalBytes). */
  maxCallBytes?: number;
}

export const DEFAULT_MAX_CALL_BYTES = 32 * 1024;

export type ByteAdmission = "ok" | "too-large" | "exhausted";

export interface RunBudget {
  /** Count one call. False when this call is past the call limit or the budget is already exhausted. */
  admitCall(): boolean;
  /** Charge `bytes` for a result about to be returned. See the header for the two refusals. */
  admitBytes(bytes: number): ByteAdmission;
  /** Bytes the next result may use: the smaller of `maxCallBytes` and what is left of the run. */
  readonly room: number;
  readonly calls: number;
  readonly bytes: number;
  readonly exhausted: boolean;
}

export function createRunBudget(limits: RunBudgetLimits): RunBudget {
  const maxCallBytes = Math.min(limits.maxCallBytes ?? DEFAULT_MAX_CALL_BYTES, limits.maxTotalBytes);
  let calls = 0;
  let bytes = 0;
  let exhausted = false;
  return {
    admitCall() {
      calls++;
      if (calls > limits.maxCalls) exhausted = true;
      return !exhausted;
    },
    admitBytes(n) {
      if (exhausted) return "exhausted";
      if (n > maxCallBytes) return "too-large";
      if (bytes + n > limits.maxTotalBytes) {
        exhausted = true;
        return "exhausted";
      }
      bytes += n;
      return "ok";
    },
    get room() {
      return exhausted ? 0 : Math.min(maxCallBytes, limits.maxTotalBytes - bytes);
    },
    get calls() {
      return calls;
    },
    get bytes() {
      return bytes;
    },
    get exhausted() {
      return exhausted;
    },
  };
}
