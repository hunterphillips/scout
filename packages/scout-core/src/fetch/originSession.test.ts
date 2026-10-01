import { describe, expect, it } from "vitest";
import { isRefusal } from "../catalog/pacing.js";
import type { GuardedFetchResult } from "./guardedFetch.js";
import { createOriginFetchSession } from "./originSession.js";

const ORIGIN = "https://shop.example";

describe("createOriginFetchSession", () => {
  it("cancel lets the request in flight finish and refuses every later one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const session = createOriginFetchSession({
      origin: ORIGIN,
      clock: { now: () => 0 },
      sleep: async () => undefined,
      guardedFetch: async (url): Promise<GuardedFetchResult> => {
        calls.push(new URL(url).pathname);
        await gate;
        return { kind: "ok", status: 200, body: "abc", bytes: new Uint8Array(3), finalUrl: url };
      },
    });
    session.startWindow();
    const inFlight = session.fetch(`${ORIGIN}/robots.txt`);
    const queued = session.fetch(`${ORIGIN}/llms.txt`);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls).toEqual(["/robots.txt"]);

    expect(session.isCancelled()).toBe(false);
    session.cancel();
    expect(session.isCancelled()).toBe(true);
    release();
    expect((await inFlight).kind).toBe("ok");
    expect(isRefusal(await queued)).toBe(true);
    session.startWindow();
    expect(isRefusal(await session.fetch(`${ORIGIN}/AGENTS.md`))).toBe(true);
    expect(calls).toEqual(["/robots.txt"]);
    expect(session.stats()).toEqual({ requests: 1, refused: 2, bytesReceived: 3 });
  });
});
