// Test-only harness (never bundled): a started background over the fake
// chrome, plus helpers to send content messages and read what reached the port.

import { createBackground, FOCUS_DEBOUNCE_MS, GITHUB_PATTERN } from "./background-core.js";
import { asChrome, type FakeChrome, fakeClock, makeChrome, sender } from "./test-fakes.js";

export const ISSUE1 = "https://github.com/acme/widgets/issues/1";
export const ISSUE2 = "https://github.com/acme/widgets/issues/2";

export type Bg = ReturnType<typeof createBackground>;

/** Default: GitHub granted and its capture toggle on, so the gate's other checks are what tests exercise. */
export async function setup(opts: Parameters<typeof makeChrome>[0] = { granted: [GITHUB_PATTERN] }, start?: number) {
  const f = makeChrome(opts);
  const clock = fakeClock(start);
  const bg = createBackground(asChrome(f), { clock });
  await bg.start();
  await clock.advance(FOCUS_DEBOUNCE_MS);
  return { f, clock, bg };
}

export const lastPort = (f: FakeChrome) => f._.ports.at(-1)!;

/** Browser observations posted on any native port (window commands are not observations). */
export const observations = (f: FakeChrome, kind?: string) =>
  f._.ports.flatMap((p) => p.posted).filter((m) => m["kind"] !== undefined && (kind === undefined || m["kind"] === kind));

/** Window commands posted on any native port. */
export const commandsPosted = (f: FakeChrome) => f._.ports.flatMap((p) => p.posted).filter((m) => m["type"] === "command").map((m) => m["command"] as Record<string, unknown>);

export const approve = (bg: Bg, f: FakeChrome, s: Parameters<typeof sender>[1] = {}, navCounter = 3, url = ISSUE1) =>
  bg.handleMessage({ type: "approve", navCounter, url }, sender(f, s)) as Promise<{ approved: boolean; reason?: string }>;

export const pageText = (bg: Bg, f: FakeChrome, s: Parameters<typeof sender>[1] = {}, navCounter = 3, url = ISSUE1) =>
  bg.handleMessage({ type: "page_text", navCounter, url, title: "One", text: "body", truncated: false }, sender(f, s)) as Promise<{
    ok: boolean;
    reason?: string;
  }>;

/** Simulate the host dropping the port. */
export function dropPort(f: FakeChrome): void {
  const p = lastPort(f);
  p.disconnected = true;
  p.onDisconnect.emit(p);
}

const policyRevisions = new WeakMap<FakeChrome, number>();

/**
 * The core's capture_policy after a pause or resume from anywhere (the panel, the Mac menu, the
 * window): each call carries a newer revision than the last (the fake core's own starts at 2).
 */
export function corePolicy(f: FakeChrome, paused: boolean, captureEnabled = true): void {
  const revision = (policyRevisions.get(f) ?? 9) + 1;
  policyRevisions.set(f, revision);
  lastPort(f).onMessage.emit({ type: "capture_policy", revision, paused, captureEnabled });
}
