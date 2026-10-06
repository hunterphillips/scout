import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCOUT_VERSION } from "./version.js";

describe("SCOUT_VERSION", () => {
  it("matches the version in this package's package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SCOUT_VERSION).toBe(pkg.version);
  });
});
