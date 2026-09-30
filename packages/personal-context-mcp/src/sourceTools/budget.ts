// The run budget across all source tools: at most `maxCalls` calls and `maxTotalBytes`
// returned. Every call counts, refused ones included. The call that would go past either
// limit is refused, and from then on the budget is exhausted: every later call returns
// `budget_exhausted` too, whatever its size.

export interface RunBudgetLimits {
  maxCalls: number;
  maxTotalBytes: number;
}

export interface RunBudget {
  /** Count one call. False when this call is past the call limit or the budget is already exhausted. */
  admitCall(): boolean;
  /** Charge `bytes` for a result about to be returned. False (and exhausted from now on) when it would go past the byte limit. */
  admitBytes(bytes: number): boolean;
  readonly calls: number;
  readonly bytes: number;
  readonly exhausted: boolean;
}

export function createRunBudget(limits: RunBudgetLimits): RunBudget {
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
      if (exhausted) return false;
      if (bytes + n > limits.maxTotalBytes) {
        exhausted = true;
        return false;
      }
      bytes += n;
      return true;
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
