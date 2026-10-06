import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BRIDGE_PROTOCOL,
  BridgeFrameSchema,
  HelloSchema,
  NATIVE_COMMAND_MAX_BYTES,
  NativeCommandSchema,
  PanelStateSchema,
  RelayCommandSchema,
  STDIO_ONLY_COMMANDS,
  StdioOnlyCommandFrameSchema,
  ToChromeFrameSchema,
} from "./index.js";
import { MAX_FRAME_TO_CHROME, MAX_PANEL_FRAME_BYTES } from "./frame.js";

// Bridge protocol 3 fixtures (packages/contracts/fixtures/bridge/), the frames the browser side
// panel builds against: `to-core.*` must parse as a BridgeFrame, `to-chrome.*` as a
// ToChromeFrame, and `refused.*` as neither. The panel fixtures (fixtures/panel/) are checked
// wrapped in bridge frames too.
const BRIDGE_DIR = fileURLToPath(new URL("../fixtures/bridge/", import.meta.url));
const PANEL_DIR = fileURLToPath(new URL("../fixtures/panel/", import.meta.url));

type Fixture = { file: string; value: unknown };
const load = (dir: string, prefix: string): Fixture[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
    .sort()
    .map((file) => ({ file, value: JSON.parse(readFileSync(dir + file, "utf8")) as unknown }));

const toCore = load(BRIDGE_DIR, "to-core.");
const toChrome = load(BRIDGE_DIR, "to-chrome.");
const refused = load(BRIDGE_DIR, "refused.");

type Def = { type: string; discriminator?: string; options?: z.ZodType[]; shape?: Record<string, z.ZodType> };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** The `type` literal of an object schema (the first option's, for a nested union). */
function typeOf(schema: z.ZodType): string {
  const def = defOf(schema);
  if (def.type === "union" && def.options) return typeOf(def.options[0]!);
  const field = def.shape?.["type"] as unknown as { _zod: { values?: Set<unknown> } } | undefined;
  return [...(field?._zod.values ?? [])].map(String).join("|");
}

/** The top-level members of a discriminated union, by `type`. */
const members = (schema: z.ZodType): Array<{ name: string; schema: z.ZodType }> =>
  (defOf(schema).options ?? []).map((m) => ({ name: typeOf(m), schema: m }));

const uncovered = (schema: z.ZodType, values: unknown[]): string[] =>
  members(schema)
    .filter(({ schema: m }) => !values.some((v) => m.safeParse(v).success))
    .map(({ name }) => name);

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

describe("bridge protocol 3", () => {
  it("is protocol 3, and a protocol-2 hello is not a bridge frame (the core answers it upgrade_required)", () => {
    expect(BRIDGE_PROTOCOL).toBe(3);
    expect(HelloSchema.parse({ type: "hello", protocol: 3 })).toEqual({ type: "hello", protocol: 3 });
    expect(BridgeFrameSchema.safeParse({ type: "hello", protocol: 2 }).success).toBe(false);
  });

  it("classifies every native command as relayed or stdio-only, never both", () => {
    const relayed = members(RelayCommandSchema).map((m) => m.name);
    const stdioOnly: readonly string[] = STDIO_ONLY_COMMANDS;
    for (const { name } of members(NativeCommandSchema)) {
      expect(relayed.includes(name) !== stdioOnly.includes(name), name).toBe(true);
    }
    expect(stdioOnly).toEqual(["frontmost", "shutdown"]);
    // The relay members are the very schemas NativeCommandSchema is built from.
    const native = new Map(members(NativeCommandSchema).map((m) => [m.name, m.schema]));
    for (const m of members(RelayCommandSchema)) expect(native.get(m.name), m.name).toBe(m.schema);
  });

  it("refuses frontmost and shutdown as relay commands", () => {
    expect(BridgeFrameSchema.safeParse({ type: "command", command: { type: "frontmost", bundleId: "com.google.Chrome", at: 1 } }).success).toBe(false);
    expect(BridgeFrameSchema.safeParse({ type: "command", command: { type: "shutdown" } }).success).toBe(false);
    expect(BridgeFrameSchema.parse({ type: "command", command: { type: "pause" } })).toEqual({ type: "command", command: { type: "pause" } });
    expect(BridgeFrameSchema.safeParse({ type: "command", command: { type: "approve", commandId: "a" } }).success).toBe(false);
  });

  it("carries any panel state in a panel frame, and nothing else", () => {
    expect(ToChromeFrameSchema.parse({ type: "panel", state: { type: "grant", agentBrowserContext: false } })).toEqual({
      type: "panel",
      state: { type: "grant", agentBrowserContext: false },
    });
    expect(ToChromeFrameSchema.safeParse({ type: "panel", state: { type: "ready" } }).success).toBe(false);
    expect(ToChromeFrameSchema.safeParse({ type: "panel" }).success).toBe(false);
    // A results frame never carries an href, wrapped or not.
    const results = { type: "results", coreInstanceId: "c", visitEpoch: 1, origin: "https://x.example", jobId: "j", status: "empty" };
    expect(ToChromeFrameSchema.safeParse({ type: "panel", state: results }).success).toBe(true);
    expect(ToChromeFrameSchema.safeParse({ type: "panel", state: { ...results, href: "https://x.example/a" } }).success).toBe(false);
  });
});

describe("bridge fixtures", () => {
  it.each(toCore.map((f) => [f.file, f] as const))("%s parses as a BridgeFrame", (_f, { value }) => {
    const r = BridgeFrameSchema.safeParse(value);
    expect(r.success, r.error?.message).toBe(true);
  });

  it.each(toChrome.map((f) => [f.file, f] as const))("%s parses as a ToChromeFrame under its cap", (_f, { value }) => {
    const r = ToChromeFrameSchema.safeParse(value);
    expect(r.success, r.error?.message).toBe(true);
    expect(bytes(value)).toBeLessThanOrEqual(r.data?.type === "panel" ? MAX_PANEL_FRAME_BYTES : MAX_FRAME_TO_CHROME);
  });

  it.each(refused.map((f) => [f.file, f] as const))("%s is refused", (_f, { value }) => {
    expect(BridgeFrameSchema.safeParse(value).success).toBe(false);
    expect(ToChromeFrameSchema.safeParse(value).success).toBe(false);
    // A refused command is still recognised as one, so the core can answer it not_permitted.
    const isCommand = (value as { type?: string }).type === "command";
    expect(StdioOnlyCommandFrameSchema.safeParse(value).success).toBe(isCommand);
  });

  it("recognises a stdio-only command frame with or without a valid commandId, and nothing else", () => {
    expect(StdioOnlyCommandFrameSchema.parse({ type: "command", command: { type: "shutdown", commandId: "s-1" } })).toEqual({
      type: "command",
      command: { type: "shutdown", commandId: "s-1" },
    });
    expect(StdioOnlyCommandFrameSchema.parse({ type: "command", command: { type: "frontmost", bundleId: "x", at: 1 } })).toEqual({ type: "command", command: { type: "frontmost" } });
    expect(StdioOnlyCommandFrameSchema.safeParse({ type: "command", command: { type: "shutdown", commandId: "bad id!" } }).success).toBe(false);
    expect(StdioOnlyCommandFrameSchema.safeParse({ type: "command", command: { type: "pause" } }).success).toBe(false);
  });

  it("covers every bridge frame, to-Chrome frame and relay command", () => {
    expect(uncovered(BridgeFrameSchema, toCore.map((f) => f.value))).toEqual([]);
    expect(uncovered(ToChromeFrameSchema, toChrome.map((f) => f.value))).toEqual([]);
    const commands = toCore.map((f) => (f.value as { command?: unknown }).command).filter((c) => c !== undefined);
    expect(uncovered(RelayCommandSchema, commands)).toEqual([]);
    const refusedTypes = refused.map((f) => (f.value as { command?: { type?: string } }).command?.type).filter((t) => t !== undefined);
    expect(refusedTypes.sort()).toEqual([...STDIO_ONLY_COMMANDS].sort());
  });

  it("every relayed command still fits one native-app command line", () => {
    for (const { file, value } of toCore) {
      const command = (value as { command?: unknown }).command;
      if (command === undefined) continue;
      expect(Buffer.byteLength(`${JSON.stringify(command)}\n`, "utf8"), file).toBeLessThan(NATIVE_COMMAND_MAX_BYTES);
    }
  });

  it("every panel frame fixture is a panel frame, and every panel command fixture is relayed or refused by its class", () => {
    for (const { file, value } of load(PANEL_DIR, "frame.")) {
      expect(PanelStateSchema.safeParse(value).success, file).toBe(true);
      expect(ToChromeFrameSchema.safeParse({ type: "panel", state: value }).success, file).toBe(true);
    }
    for (const { file, value } of load(PANEL_DIR, "command.")) {
      const type = (value as { type: string }).type;
      const stdioOnly = (STDIO_ONLY_COMMANDS as readonly string[]).includes(type);
      expect(BridgeFrameSchema.safeParse({ type: "command", command: value }).success, file).toBe(!stdioOnly);
    }
  });
});
