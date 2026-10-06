import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { NATIVE_COMMAND_MAX_BYTES, NativeCommandSchema, PanelStateSchema } from "./index.js";

// The panel fixtures: one hand-written JSON file per frame or command, valid under this
// contract. Every file in the directory is checked, so a new fixture is covered without editing
// this test. The Mac app's tests read a subset of them from their own fixtures directory.
const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/panel/", import.meta.url));
const SWIFT_FIXTURES_DIR = fileURLToPath(new URL("../../../native/Scout/Tests/Fixtures/", import.meta.url));
const SWIFT_PROTOCOL = fileURLToPath(new URL("../../../native/Scout/Sources/ScoutKit/Protocol.swift", import.meta.url));

type Fixture = { file: string; value: unknown };

const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
const load = (prefix: string): Fixture[] =>
  fixtureFiles
    .filter((f) => f.startsWith(prefix))
    .map((file) => ({ file, value: JSON.parse(readFileSync(FIXTURES_DIR + file, "utf8")) as unknown }));

const frames = load("frame.");
const commands = load("command.");

type Leaf = { name: string; schema: z.ZodType };

// Flattens nested discriminated unions into their object members, naming each by its
// `type` plus any inner discriminator values (e.g. `ack ok=true`).
function leaves(schema: z.ZodType, qualifiers: string[] = []): Leaf[] {
  const def = (schema as unknown as { _zod: { def: { type: string; discriminator?: string; options?: z.ZodType[] } } })._zod.def;
  if (def.type === "union" && def.discriminator !== undefined && def.options) {
    return def.options.flatMap((option) => {
      const inner = discriminatorValues(option, def.discriminator!);
      const tag = def.discriminator === "type" ? inner : `${def.discriminator}=${inner}`;
      return leaves(option, def.discriminator === "type" ? qualifiers : [...qualifiers, tag]);
    });
  }
  const type = discriminatorValues(schema, "type");
  return [{ name: [type, ...qualifiers].join(" "), schema }];
}

function discriminatorValues(schema: z.ZodType, key: string): string {
  const def = (schema as unknown as { _zod: { def: { type: string; shape?: Record<string, z.ZodType>; options?: z.ZodType[] } } })._zod.def;
  if (def.type === "union" && def.options) return discriminatorValues(def.options[0]!, key);
  const field = def.shape?.[key] as unknown as { _zod: { values?: Set<unknown> } } | undefined;
  return [...(field?._zod.values ?? [])].map(String).join("|");
}

function uncovered(schema: z.ZodType, fixtures: Fixture[]): string[] {
  return leaves(schema)
    .filter(({ schema: leaf }) => !fixtures.some(({ value }) => leaf.safeParse(value).success))
    .map(({ name }) => name);
}

describe("panel fixtures", () => {
  it("every fixture is a frame or a command", () => {
    expect(fixtureFiles.filter((f) => !f.startsWith("frame.") && !f.startsWith("command."))).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(frames.map((f) => [f.file, f] as const))("%s parses as a PanelState", (_file, { value }) => {
    const result = PanelStateSchema.safeParse(value);
    expect(result.success, result.error?.message).toBe(true);
  });

  it.each(commands.map((f) => [f.file, f] as const))("%s parses as a NativeCommand within the byte limit", (_file, { value }) => {
    const result = NativeCommandSchema.safeParse(value);
    expect(result.success, result.error?.message).toBe(true);
    const line = `${JSON.stringify(value)}\n`;
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(NATIVE_COMMAND_MAX_BYTES);
  });

  it("the app's command limit is the contract's", () => {
    const swift = readFileSync(SWIFT_PROTOCOL, "utf8");
    expect(Number(/static let commandMaxBytes = (\d+)/.exec(swift)?.[1])).toBe(NATIVE_COMMAND_MAX_BYTES);
  });

  it("every Mac app fixture is a byte-identical copy of a panel fixture", () => {
    const swiftFiles = readdirSync(SWIFT_FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    expect(swiftFiles.length).toBeGreaterThan(0);
    for (const file of swiftFiles) {
      expect(fixtureFiles, file).toContain(file);
      expect(readFileSync(SWIFT_FIXTURES_DIR + file).equals(readFileSync(FIXTURES_DIR + file)), file).toBe(true);
    }
  });

  it("every PanelState member has a fixture", () => {
    expect(uncovered(PanelStateSchema, frames)).toEqual([]);
  });

  it("every NativeCommand member has a fixture", () => {
    expect(uncovered(NativeCommandSchema, commands)).toEqual([]);
  });
});
