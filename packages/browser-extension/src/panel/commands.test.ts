// Ported from native/Scout/Tests/ScoutKitTests/CommandTrackerTests.swift, case for case, plus
// the browser rules (random `sp-` IDs, open_link never left unsent, the byte limit).
import { CommandIdSchema, NATIVE_COMMAND_MAX_BYTES, RelayCommandSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { COMMAND_MAX_BYTES, commandLineBytes, CommandTracker, PENDING_TIMEOUT_MS, type PanelRequest, randomCommandId } from "./commands.js";
import { F, tracker } from "./test-frames.js";

const approve: PanelRequest = { type: "approve", resourceId: F.rid, version: F.v1, expectedRevision: 1 };
const ok = (commandId: string, revision = 0, approvalRevision = 0) => ({ type: "ack" as const, commandId, ok: true as const, revision, approvalRevision });
const failed = (commandId: string, code: "stale_revision" | "not_found" | "invalid" | "store_error" | "not_permitted" | "unavailable", revision?: number) => ({
  type: "ack" as const,
  commandId,
  ok: false as const,
  code,
  ...(revision !== undefined ? { revision } : {}),
});

describe("CommandTracker (CommandTrackerTests.swift)", () => {
  it("issuesDistinctWellFormedIds", () => {
    const t = tracker("run1");
    const a = t.issue(approve);
    const b = t.issue({ type: "refresh_capabilities" });
    expect([a.commandId, b.commandId]).toEqual(["run1-1", "run1-2"]);
    expect(t.record("run1-1")?.state).toBe("pending");
  });

  it("acksMapToStates", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    const b = t.issue({ type: "revoke", resourceId: F.rid, expectedRevision: 2 });
    t.apply(ok(a.commandId, 2, 3));
    t.apply(failed(b.commandId, "stale_revision", 4));
    expect(t.record(a.commandId)?.state).toBe("ok");
    expect(t.record(b.commandId)).toMatchObject({ state: "failed", code: "stale_revision" });
    t.apply(ok(a.commandId, 2, 3));
    expect(t.apply(ok("nope"))).toBeUndefined();
    expect(t.record(a.commandId)?.state).toBe("ok");
    expect(t.records).toHaveLength(2);
  });

  it("everyFailureCodeIsKept", () => {
    const t = tracker("p");
    for (const code of ["stale_revision", "not_found", "invalid", "store_error", "not_permitted", "unavailable"] as const) {
      const c = t.issue({ type: "refresh_capabilities" });
      t.apply(failed(c.commandId, code));
      expect(t.record(c.commandId)).toMatchObject({ state: "failed", code });
    }
  });

  it("droppedWriteIsResentWithTheSameId", () => {
    const t = tracker("p");
    const c = t.issue(approve);
    t.markSent(c.commandId, "retryLater");
    expect(t.unsent).toEqual([c]);
    t.markSent(c.commandId, "written");
    expect(t.unsent).toEqual([]);
    expect(t.record(c.commandId)?.state).toBe("pending");
  });

  it("restartResendsPendingMutationsWithSameIdsAndFailsPreviews", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    const done = t.issue({ type: "refresh_capabilities" });
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1, cursor: "c1" });
    for (const c of [a, done, p]) t.markSent(c.commandId, "written");
    t.apply(ok(done.commandId, 0, 1));
    expect(t.coreRestarted()).toEqual([a]);
    expect(t.record(p.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
    expect(t.records).toHaveLength(3);
    t.apply(ok(a.commandId, 2, 2));
    expect(t.record(a.commandId)?.state).toBe("ok");
  });

  it("restartNeverResendsTogglesAndSettlesThemAsUnknown", () => {
    const t = tracker("p");
    const auto = t.issue({ type: "set_auto_acquire", origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false });
    const grant = t.issue({ type: "set_agent_browser_context", enabled: true, expectedEnabled: false });
    const refresh = t.issue({ type: "refresh_capabilities" });
    const revoke = t.issue({ type: "revoke", resourceId: F.rid, expectedRevision: 2 });
    t.markSent(auto.commandId, "written");
    t.markSent(grant.commandId, "retryLater");
    expect(t.unsent).toContainEqual(grant);
    expect(t.coreRestarted()).toEqual([revoke]);
    for (const c of [auto, grant, refresh]) expect(t.record(c.commandId)?.state).toBe("unknown");
    expect(t.unsent).toEqual([revoke]);
  });

  it("togglesAreNeverRetried", () => {
    const t = tracker("p");
    const grant = t.issue({ type: "set_agent_browser_context", enabled: true, expectedEnabled: false });
    t.apply(failed(grant.commandId, "unavailable"));
    expect(t.retry(grant.commandId)).toBeUndefined();
    const auto = t.issue({ type: "set_auto_acquire", origin: F.origin, enabled: false, acknowledgeRisk: false, expectedEnabled: true });
    t.markSent(auto.commandId, "retryLater");
    expect(t.retry(auto.commandId)).toBeUndefined();
    expect(t.record(grant.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
  });

  it("retryReusesTheIdForFailedMutationsOnly", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    t.markSent(a.commandId, "written");
    expect(t.retry(a.commandId)).toBeUndefined();
    t.apply(failed(a.commandId, "store_error"));
    expect(t.retry(a.commandId)).toEqual(a);
    expect(t.record(a.commandId)?.state).toBe("pending");
    expect(t.records).toHaveLength(1);
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1 });
    t.apply(failed(p.commandId, "not_found"));
    expect(t.retry(p.commandId)).toBeUndefined();
  });

  it("boundedToTheLast64PreferringSettled", () => {
    const t = tracker("p");
    const first = t.issue(approve);
    for (let i = 0; i < 100; i++) {
      const c = t.issue({ type: "refresh_capabilities" });
      t.apply(ok(c.commandId));
    }
    expect(t.records).toHaveLength(CommandTracker.capacity);
    expect(t.record(first.commandId)?.state).toBe("pending");
    expect(t.records.at(-1)?.id).toBe("p-101");
  });

  it("previewChunkSettlesItsCommand", () => {
    const t = tracker("p");
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1 });
    t.chunkArrived(p.commandId);
    expect(t.record(p.commandId)?.state).toBe("ok");
  });

  it("aChunkNamingANonPreviewCommandSettlesNothing", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    const r = t.issue({ type: "refresh_capabilities" });
    t.apply(failed(r.commandId, "unavailable"));
    t.chunkArrived(a.commandId);
    t.chunkArrived(r.commandId);
    expect(t.record(a.commandId)).toMatchObject({ state: "pending", sent: false });
    expect(t.record(r.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
  });

  it("supersededPreviewIsSettledAndNeverResent", () => {
    const t = tracker("p");
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1 });
    t.markSent(p.commandId, "retryLater");
    expect(t.unsent).toEqual([p]);
    t.supersede(p.commandId);
    expect(t.record(p.commandId)?.state).toBe("superseded");
    expect(t.unsent).toEqual([]);
    expect(t.coreRestarted()).toEqual([]);
    expect(t.canRetry(p.commandId)).toBe(false);
    t.chunkArrived(p.commandId);
    expect(t.record(p.commandId)?.state).toBe("superseded");
    const a = t.issue(approve);
    t.supersede(a.commandId);
    expect(t.record(a.commandId)?.state).toBe("pending");
  });

  it("oversizeWriteFailsAsInvalidAndIsNeverResent", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    t.markSent(a.commandId, "oversize");
    expect(t.record(a.commandId)).toMatchObject({ state: "failed", code: "invalid" });
    expect(t.unsent).toEqual([]);
    expect(t.canRetry(a.commandId)).toBe(false);
    expect(t.retry(a.commandId)).toBeUndefined();
    expect(t.coreRestarted()).toEqual([]);
    const b = t.issue(approve);
    t.markSent(b.commandId, "retryLater");
    expect(t.unsent).toEqual([b]);
    expect(t.canRetry(b.commandId)).toBe(true);
    t.markSent(b.commandId, "written");
    expect(t.unsent).toEqual([]);
    expect(t.canRetry(b.commandId)).toBe(false);
  });

  it("canRetryMatchesRetry", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    const grant = t.issue({ type: "set_agent_browser_context", enabled: true, expectedEnabled: false });
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1 });
    t.apply(failed(a.commandId, "store_error"));
    t.apply(failed(grant.commandId, "unavailable"));
    t.apply(failed(p.commandId, "unavailable"));
    expect([t.canRetry(a.commandId), t.canRetry(grant.commandId), t.canRetry(p.commandId), t.canRetry("nope")]).toEqual([true, false, false, false]);
    expect(t.retry(a.commandId)).toEqual(a);
    t.apply(failed(a.commandId, "not_found"));
    expect(t.canRetry(a.commandId)).toBe(false);
    expect(t.retry(a.commandId)).toBeUndefined();
  });
});

describe("browser rules", () => {
  it("ids are sp- plus 128 random bits, valid command ids, never repeated", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomCommandId()));
    expect(ids.size).toBe(2000);
    for (const id of [...ids].slice(0, 50)) {
      expect(id).toMatch(/^sp-[A-Za-z0-9_-]{22}$/);
      expect(CommandIdSchema.safeParse(id).success).toBe(true);
    }
    const t = new CommandTracker();
    expect(t.issue(approve).commandId).toMatch(/^sp-/);
  });

  it("an open_link the worker could not send fails at once and is never re-sent", () => {
    const t = tracker("p");
    const c = t.issue({ type: "open_link", coreInstanceId: "core-1", visitEpoch: 1, jobId: "job-1", candidateId: "c1" });
    t.markSent(c.commandId, "retryLater");
    expect(t.record(c.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
    expect(t.unsent).toEqual([]);
    expect(t.canRetry(c.commandId)).toBe(false);
  });

  it("every issued command is a relay command; the byte limit is the contract's", () => {
    expect(COMMAND_MAX_BYTES).toBe(NATIVE_COMMAND_MAX_BYTES);
    const t = new CommandTracker();
    const all: PanelRequest[] = [
      approve,
      { type: "decline", resourceId: F.rid, version: F.v1, expectedRevision: 1 },
      { type: "revoke", resourceId: F.rid, expectedRevision: 1 },
      { type: "preview", resourceId: F.rid, version: F.v1 },
      { type: "preview", resourceId: F.rid, version: F.v1, cursor: "cur_A-1" },
      { type: "set_auto_acquire", origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false },
      { type: "set_agent_browser_context", enabled: true, expectedEnabled: false },
      { type: "refresh_capabilities" },
      { type: "open_link", coreInstanceId: "core-7f3a9c", visitEpoch: 3, jobId: "job-3a", candidateId: "c1" },
    ];
    for (const r of all) {
      const c = t.issue(r);
      expect(RelayCommandSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
      expect(commandLineBytes(c)).toBeLessThan(COMMAND_MAX_BYTES);
    }
  });

  it("a written command the core never answers expires after 10 s: decisions retryable, clicks Dismiss only, toggles unknown, previews failed", () => {
    const t = tracker("p");
    const a = t.issue(approve);
    const click = t.issue({ type: "open_link", coreInstanceId: "core-1", visitEpoch: 1, jobId: "job-1", candidateId: "c1" });
    const grant = t.issue({ type: "set_agent_browser_context", enabled: true, expectedEnabled: false });
    const p = t.issue({ type: "preview", resourceId: F.rid, version: F.v1 });
    const unsent = t.issue({ type: "refresh_capabilities" });
    for (const c of [a, click, grant, p]) t.markSent(c.commandId, "written", 1_000);
    expect(t.expire(1_000 + PENDING_TIMEOUT_MS - 1)).toEqual([]);
    expect(t.expire(1_000 + PENDING_TIMEOUT_MS).map((r) => r.id)).toEqual([a.commandId, click.commandId, grant.commandId, p.commandId]);
    expect(t.record(a.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
    expect(t.retry(a.commandId)).toEqual(a); // the same ID
    expect(t.record(click.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
    expect(t.canRetry(click.commandId)).toBe(false);
    expect(t.record(grant.commandId)?.state).toBe("unknown");
    expect(t.record(p.commandId)).toMatchObject({ state: "failed", code: "unavailable" });
    expect(t.record(unsent.commandId)?.state).toBe("pending"); // never written: the resend covers it
    // A late ack still settles what it answers.
    t.apply(ok(click.commandId));
    expect(t.record(click.commandId)?.state).toBe("ok");
  });
});
