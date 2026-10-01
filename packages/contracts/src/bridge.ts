import { z } from "zod";
import { BrowserObservationSchema } from "./browser.js";

/**
 * Protocol 2: the core answers hello with a capture-disabled capture_policy, and the
 * extension's permissions snapshot carries a revision and the GitHub-capture setting.
 * Mixed versions fail closed with upgrade_required.
 */
export const BRIDGE_PROTOCOL = 2;

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

/** Everything the core accepts on the bridge socket; the core validates each socket frame against this. */
export const BridgeFrameSchema = z.discriminatedUnion("type", [HelloSchema, ObservationFrameSchema]);

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
