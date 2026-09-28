import { describe, expect, it } from "vitest";

describe("entrypoint gate", () => {
  it("importing the entrypoint or the package root never starts the host", async () => {
    const before = process.listenerCount("SIGTERM");
    const hostModule = await import("./host.js");
    const lib = await import("./index.js");
    expect(typeof hostModule.main).toBe("function");
    expect(typeof lib.createHost).toBe("function");
    expect("main" in lib).toBe(false);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
