import { z } from "zod";

// Core -> native app (JSONL over stdio).

export const PanelStatusStateSchema = z.object({
  type: z.literal("state"),
  status: z.enum(["idle", "working", "paused", "disconnected"]),
  visitEpoch: z.int().nonnegative().optional(),
  detail: z.string().optional(),
});

export const PanelResultItemSchema = z.object({
  candidateId: z.string(),
  title: z.string(),
  href: z.string(),
  reason: z.string(),
});

export const PanelResultsListSchema = z.object({
  type: z.literal("results"),
  visitEpoch: z.int().nonnegative(),
  status: z.enum(["ok", "empty"]),
  items: z.array(PanelResultItemSchema),
});

export const PanelResultsFailureSchema = z.object({
  type: z.literal("results"),
  visitEpoch: z.int().nonnegative(),
  status: z.enum(["unavailable", "error"]),
  reason: z.string(),
});

// Two members share type "results"; zod v4 discriminates them by `status`.
export const PanelStateSchema = z.discriminatedUnion("type", [
  PanelStatusStateSchema,
  z.discriminatedUnion("status", [PanelResultsListSchema, PanelResultsFailureSchema]),
]);

// Native app -> core.

export const NativeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frontmost"), bundleId: z.string(), at: z.number() }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("shutdown") }),
]);

export type PanelResultItem = z.infer<typeof PanelResultItemSchema>;
export type PanelState = z.infer<typeof PanelStateSchema>;
export type NativeCommand = z.infer<typeof NativeCommandSchema>;
