// run.mjs argument parsing and abort reasons.

import { describe, expect, it } from "vitest";
import { abortReason, parseArgs, PLAN_BUDGET_QUOTE } from "./run.mjs";

describe("parseArgs: inference budget", () => {
  const base = ["--case", "hotload", "--home", "/tmp/x"];

  it("defaults to 2", () => {
    expect(parseArgs(base).opts.maxInference).toBe(2);
  });

  it("refuses more than 2 without --acknowledge-budget, quoting the plan", () => {
    const r = parseArgs([...base, "--max-inference", "3"]);
    expect(r.error).toContain(PLAN_BUDGET_QUOTE);
    expect(r.error).toContain("--acknowledge-budget");
    expect(PLAN_BUDGET_QUOTE).toBe("at most two inference requests in one authorized check");
    expect(parseArgs([...base, "--max-inference", "3", "--acknowledge-budget"]).opts.maxInference).toBe(3);
    expect(parseArgs([...base, "--max-inference", "2"]).opts.maxInference).toBe(2);
  });
});

describe("abortReason", () => {
  it("is the event for a signal, plus the error's name and code for an uncaught error", () => {
    expect(abortReason("SIGINT", "SIGINT")).toBe("SIGINT");
    expect(abortReason("uncaughtException", new TypeError("x"))).toBe("uncaughtException_TypeError");
    expect(abortReason("unhandledRejection", Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("unhandledRejection_Error_ECONNRESET");
    expect(abortReason("unhandledRejection", "a string with /Users/someone/path")).toBe("unhandledRejection_unknown");
    expect(abortReason("uncaughtException", Object.assign(new Error("x"), { name: "has spaces and /paths", code: 42 }))).toBe("uncaughtException_unknown");
  });
});
