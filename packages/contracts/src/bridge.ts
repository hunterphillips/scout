import { z } from "zod";
import { BrowserObservationSchema } from "./browser.js";
import {
  ApproveCommandSchema,
  DeclineCommandSchema,
  type NativeCommand,
  OpenLinkCommandSchema,
  PanelStateSchema,
  PauseCommandSchema,
  PreviewCommandSchema,
  RefreshCapabilitiesCommandSchema,
  ResumeCommandSchema,
  RevokeCommandSchema,
  SetAgentBrowserContextCommandSchema,
  SetAutoAcquireCommandSchema,
} from "./panel.js";

/**
 * Protocol 2: the core answers hello with a capture-disabled capture_policy, and the
 * extension's permissions snapshot carries a revision and the GitHub-capture setting.
 * Protocol 3 adds Scout's window over the relay: the extension may send window commands
 * (`command`) and the core sends it the window's frames (`panel`), so a Chrome side panel
 * can be the UI. Mixed versions fail closed with upgrade_required.
 */
export const BRIDGE_PROTOCOL = 3;

/** Native host -> core, first frame on each socket connection. */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(BRIDGE_PROTOCOL),
});

/**
 * Any hello, whatever its protocol: the core reads this first so it can answer a
 * mismatched protocol with upgrade_required instead of dropping the connection silently.
 */
export const AnyHelloSchema = z.object({ type: z.literal("hello"), protocol: z.int() });

/** Extension -> core, one browser observation. */
export const ObservationFrameSchema = z.object({
  type: z.literal("observation"),
  observation: BrowserObservationSchema,
});

/**
 * Native-app commands the browser may never send: only the app knows which application is
 * frontmost, and only the app may quit the core. The host refuses them (they are not in
 * RelayCommandSchema) and the core answers them with a `not_permitted` ack.
 */
export const STDIO_ONLY_COMMANDS = ["frontmost", "shutdown"] as const;
export type StdioOnlyCommandType = (typeof STDIO_ONLY_COMMANDS)[number];

/**
 * The window commands the browser side panel may send: every NativeCommand member except
 * STDIO_ONLY_COMMANDS, built from the same member schemas. A command added to panel.ts must be
 * listed here or in STDIO_ONLY_COMMANDS (bridge.test.ts checks every member is in exactly one).
 */
export const RelayCommandSchema = z.discriminatedUnion("type", [
  PauseCommandSchema,
  ResumeCommandSchema,
  PreviewCommandSchema,
  ApproveCommandSchema,
  DeclineCommandSchema,
  RevokeCommandSchema,
  SetAutoAcquireCommandSchema,
  SetAgentBrowserContextCommandSchema,
  RefreshCapabilitiesCommandSchema,
  OpenLinkCommandSchema,
]);
export type RelayCommand = z.infer<typeof RelayCommandSchema>;

// Compile-time half of the classification check: every NativeCommand type is relayed or stdio-only.
type Unclassified = Exclude<NativeCommand["type"], RelayCommand["type"] | StdioOnlyCommandType>;
const _everyCommandClassified: [Unclassified] extends [never] ? true : never = true;
void _everyCommandClassified;

/**
 * Extension -> core, one window command (protocol 3). Each must still fit the native app's
 * NATIVE_COMMAND_MAX_BYTES as a JSONL line; the relay and the core check it.
 */
export const CommandFrameSchema = z.object({
  type: z.literal("command"),
  command: RelayCommandSchema,
});

/** Everything the core accepts on the bridge socket; the core validates each socket frame against this. */
export const BridgeFrameSchema = z.discriminatedUnion("type", [HelloSchema, ObservationFrameSchema, CommandFrameSchema]);

export const CORE_UNAVAILABLE_REASONS = ["upgrade_required", "unreachable", "unsafe"] as const;

/** Native host -> extension: the core socket is not reachable, or the core needs another protocol. */
export const CoreUnavailableSchema = z.object({
  type: z.literal("core_unavailable"),
  reason: z.enum(CORE_UNAVAILABLE_REASONS).optional(),
});

/** Core -> extension: a page_text observation with this seq was accepted. */
export const AckSchema = z.object({ type: z.literal("ack"), seq: z.int().nonnegative() });

/** Native host -> extension: the core socket is connected and hello was sent. */
export const ReadySchema = z.object({ type: z.literal("ready") });

/**
 * Core -> extension: what the extension may capture. The core's answer to hello is a
 * capture-disabled policy; an enabling one follows only after it has validated the
 * extension's permissions snapshot. A policy can restrict capture, never grant it: the
 * extension still needs Chrome's grant and its own toggle. `revision` rises with each policy.
 */
export const CapturePolicySchema = z.object({
  type: z.literal("capture_policy"),
  revision: z.int().nonnegative(),
  paused: z.boolean(),
  captureEnabled: z.boolean(),
});

/** Core -> native host: the hello's protocol is not the core's; the core closes next. */
export const UpgradeRequiredSchema = z.object({ type: z.literal("upgrade_required"), protocol: z.int() });

/**
 * Core -> extension (protocol 3): one of the window's frames, exactly as the native app gets it
 * on stdout. Up to MAX_PANEL_FRAME_BYTES on the wire (`@scout/contracts/frame`); every other
 * to-Chrome frame stays under MAX_FRAME_TO_CHROME.
 */
export const PanelFrameSchema = z.object({
  type: z.literal("panel"),
  state: PanelStateSchema,
});

/**
 * Everything the core sends on the bridge socket, which is also everything the extension
 * accepts from the native host (upgrade_required is turned into core_unavailable by the
 * host, so the extension never sees it, but it validates here either way).
 */
export const ToChromeFrameSchema = z.discriminatedUnion("type", [
  CoreUnavailableSchema,
  AckSchema,
  ReadySchema,
  CapturePolicySchema,
  UpgradeRequiredSchema,
  PanelFrameSchema,
]);

export type Hello = z.infer<typeof HelloSchema>;
export type ObservationFrame = z.infer<typeof ObservationFrameSchema>;
export type BridgeFrame = z.infer<typeof BridgeFrameSchema>;
export type AnyHello = z.infer<typeof AnyHelloSchema>;
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;
export type UpgradeRequired = z.infer<typeof UpgradeRequiredSchema>;
export type CoreUnavailableReason = (typeof CORE_UNAVAILABLE_REASONS)[number];
export type CoreUnavailable = z.infer<typeof CoreUnavailableSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type Ready = z.infer<typeof ReadySchema>;
export type ToChromeFrame = z.infer<typeof ToChromeFrameSchema>;
export type CommandFrame = z.infer<typeof CommandFrameSchema>;
export type PanelFrame = z.infer<typeof PanelFrameSchema>;
