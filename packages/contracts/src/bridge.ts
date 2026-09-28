import { z } from "zod";
import { BrowserObservationSchema } from "./browser.js";

export const BRIDGE_PROTOCOL = 1;

/** Native host -> core, first frame on each socket connection. */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(BRIDGE_PROTOCOL),
});

/** Extension -> core, one browser observation. */
export const ObservationFrameSchema = z.object({
  type: z.literal("observation"),
  observation: BrowserObservationSchema,
});

/** Everything the core accepts on the bridge socket. */
export const BridgeFrameSchema = z.discriminatedUnion("type", [HelloSchema, ObservationFrameSchema]);

/** Native host -> extension: the core socket is not reachable. */
export const CoreUnavailableSchema = z.object({ type: z.literal("core_unavailable") });

/** Core -> extension: a page_text observation with this seq was accepted. */
export const AckSchema = z.object({ type: z.literal("ack"), seq: z.int().nonnegative() });

/** Everything the extension accepts from the native host. */
export const ToChromeFrameSchema = z.discriminatedUnion("type", [CoreUnavailableSchema, AckSchema]);

export type Hello = z.infer<typeof HelloSchema>;
export type ObservationFrame = z.infer<typeof ObservationFrameSchema>;
export type BridgeFrame = z.infer<typeof BridgeFrameSchema>;
export type CoreUnavailable = z.infer<typeof CoreUnavailableSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type ToChromeFrame = z.infer<typeof ToChromeFrameSchema>;
