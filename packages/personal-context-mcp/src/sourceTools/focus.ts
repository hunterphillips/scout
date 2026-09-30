// get_focus: one GET to the configured Focus URL (loopback, validated by config), 2 s for
// the whole exchange. Any failure is `unavailable` with a fixed reason. No retry, no
// refresh call, no other endpoint, no redirect.
//
// Response shape: Focus's `GET /api/focus` returns its focus.json document,
// `{ updated, items: [{ id, title, source, tier, now, status, note?, ... }] }`
// (see focus/schema.json). A bare array of items is accepted too. Only open items are
// returned (an item without `status` counts as open), with `title`, `tier`, `now` and
// `note`; titles are cut to 200 characters, notes to 500, and at most 50 items.

import { z } from "zod";

export const FOCUS_TIMEOUT_MS = 2_000;
export const FOCUS_MAX_BODY_BYTES = 256 * 1024;
export const FOCUS_MAX_ITEMS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 500;

export type FetchLike = (
  url: string,
  init: { method: "GET"; redirect: "error"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export type FocusUnavailableReason = "timeout" | "network-error" | "http-status" | "too-large" | "bad-response";

export interface FocusItem {
  /** Focus's own item id when it is a plain token; for the audit map only. */
  id?: string;
  title: string;
  tier?: "today" | "tomorrow" | "later";
  now?: boolean;
  note?: string;
}

export type FocusResult = { ok: true; items: FocusItem[] } | { ok: false; reason: FocusUnavailableReason };

const FocusItemSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().min(1),
  status: z.string().optional(),
  tier: z.string().optional(),
  now: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

const FocusResponseSchema = z.union([z.array(FocusItemSchema), z.looseObject({ items: z.array(FocusItemSchema) })]);

const ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TIERS = new Set(["today", "tomorrow", "later"]);

function cutChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

class FocusFailure extends Error {
  constructor(readonly reason: FocusUnavailableReason) {
    super(reason);
  }
}

async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new FocusFailure("too-large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseFocusBody(text: string): FocusItem[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = FocusResponseSchema.safeParse(json);
  if (!r.success) return undefined;
  const list = Array.isArray(r.data) ? r.data : r.data.items;
  const out: FocusItem[] = [];
  for (const it of list) {
    if (it.status !== undefined && it.status !== "open") continue;
    const item: FocusItem = { title: cutChars(it.title, MAX_TITLE_CHARS) };
    if (it.id !== undefined && ITEM_ID_RE.test(it.id)) item.id = it.id;
    if (it.tier !== undefined && TIERS.has(it.tier)) item.tier = it.tier as NonNullable<FocusItem["tier"]>;
    if (it.now !== undefined) item.now = it.now;
    if (typeof it.note === "string" && it.note.length > 0) item.note = cutChars(it.note, MAX_NOTE_CHARS);
    out.push(item);
    if (out.length >= FOCUS_MAX_ITEMS) break;
  }
  return out;
}

/** One GET, bounded by `timeoutMs` end to end. Never throws. */
export async function fetchFocus(url: string, fetchImpl: FetchLike, timeoutMs: number = FOCUS_TIMEOUT_MS): Promise<FocusResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      reject(new FocusFailure("timeout"));
    }, timeoutMs);
  });
  const exchange = (async (): Promise<FocusItem[]> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", redirect: "error", signal: ctrl.signal, headers: { accept: "application/json" } });
    } catch {
      throw new FocusFailure(timedOut ? "timeout" : "network-error");
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      throw new FocusFailure("http-status");
    }
    let text: string;
    try {
      text = await readCapped(res, FOCUS_MAX_BODY_BYTES, ctrl.signal);
    } catch (e) {
      if (e instanceof FocusFailure) throw e;
      throw new FocusFailure(timedOut ? "timeout" : "network-error");
    }
    const items = parseFocusBody(text);
    if (items === undefined) throw new FocusFailure("bad-response");
    return items;
  })();
  exchange.catch(() => {}); // a late rejection after the deadline won is not unhandled
  try {
    const items = await Promise.race([exchange, deadline]);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: e instanceof FocusFailure ? e.reason : "network-error" };
  } finally {
    clearTimeout(timer);
    deadline.catch(() => {});
    if (!ctrl.signal.aborted) ctrl.abort();
  }
}
