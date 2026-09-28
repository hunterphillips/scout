import type { PageTextObservation } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { createActivityForwarder } from "./activityForwarder.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";

function spyDiagnostics() {
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  return { events, diagnostics };
}

const OBS: PageTextObservation = {
  kind: "page_text",
  seq: 5,
  at: 1,
  tabId: 3,
  documentId: "doc",
  url: "https://github.com/o/r/issues/1",
  source: "github_issue",
  title: "Secret title",
  text: "héllo",
  truncated: true,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("activityForwarder", () => {
  it("default send logs byte and truncation counts only, never text or url", async () => {
    const { events, diagnostics } = spyDiagnostics();
    const f = createActivityForwarder({ diagnostics });
    await f.forward(OBS);
    expect(events[0]).toEqual({ name: "activity_forwarded", fields: { bytes: 6, truncated: true } });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("héllo");
    expect(logged).not.toContain("github.com");
    expect(logged).not.toContain("Secret");
  });

  it("bumps contextRevision synchronously and tracks pending until ack or failure", async () => {
    const { events, diagnostics } = spyDiagnostics();
    const sends = [deferred(), deferred()];
    let i = 0;
    const f = createActivityForwarder({ diagnostics, send: () => sends[i++]!.promise });
    expect(f.contextRevision).toBe(0);
    const a = f.forward(OBS);
    expect(f.contextRevision).toBe(1);
    const b = f.forward({ ...OBS, seq: 6 });
    expect(f.contextRevision).toBe(2);
    expect(f.pendingCount).toBe(2);

    sends[0]!.resolve();
    await a;
    expect(f.pendingCount).toBe(1);
    sends[1]!.reject(new Error("service down"));
    await expect(b).resolves.toBeUndefined();
    expect(f.pendingCount).toBe(0);
    expect(f.contextRevision).toBe(2);
    expect(events.map((e) => [e.name, e.fields.contextRevision])).toEqual([
      ["activity_acked", 1],
      ["activity_failed", 2],
    ]);
  });

  it("a synchronously throwing send counts as failed, not thrown", async () => {
    const { events, diagnostics } = spyDiagnostics();
    const f = createActivityForwarder({
      diagnostics,
      send: () => {
        throw new Error("boom");
      },
    });
    await expect(f.forward(OBS)).resolves.toBeUndefined();
    expect(f.pendingCount).toBe(0);
    expect(events.map((e) => e.name)).toEqual(["activity_failed"]);
  });
});
