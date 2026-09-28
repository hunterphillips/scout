// Test-only harness (never bundled): a started background over the fake
// chrome, plus helpers to send content messages and read what reached the port.

import { createBackground, FOCUS_DEBOUNCE_MS, GITHUB_PATTERN } from "./background-core.js";
import { asChrome, type FakeChrome, fakeClock, makeChrome, sender } from "./test-fakes.js";

export const ISSUE1 = "https://github.com/acme/widgets/issues/1";
export const ISSUE2 = "https://github.com/acme/widgets/issues/2";

export type Bg = ReturnType<typeof createBackground>;

export async function setup(opts: Parameters<typeof makeChrome>[0] = { granted: [GITHUB_PATTERN] }, start?: number) {
  const f = makeChrome(opts);
  const clock = fakeClock(start);
  const bg = createBackground(asChrome(f), { clock });
  await bg.start();
  await clock.advance(FOCUS_DEBOUNCE_MS);
  return { f, clock, bg };
}

export const lastPort = (f: FakeChrome) => f._.ports.at(-1)!;

export const observations = (f: FakeChrome, kind?: string) =>
  f._.ports.flatMap((p) => p.posted).filter((m) => kind === undefined || m["kind"] === kind);

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
