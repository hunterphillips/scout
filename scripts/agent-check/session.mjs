// One multi-turn headless Claude session: `claude -p --input-format stream-json
// --output-format stream-json ...`, kept open across turns. Each send() writes one user
// message to stdin and resolves with the events up to that turn's `result` event. This is
// the hot-load check's stand-in for an already-open interactive session: the process, its
// skill watcher and its MCP connections persist between turns.
//
// The process is spawned argv-only and detached (scout-core's childSupervisor), so close()
// can end stdin, then terminate and reap the whole tree if it does not exit.

import { spawn as nodeSpawn } from "node:child_process";
import { startChild } from "../../packages/scout-core/dist/agents/childSupervisor.js";
import { createJsonLineStream } from "../../packages/scout-core/dist/agents/jsonLineStream.js";
import { OwnedTree, psSnapshot } from "../../packages/scout-core/dist/agents/processTree.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const EXIT_WAIT_MS = 10_000;

export function userMessage(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" }) + "\n";
}

/**
 * @param {{ claudePath: string, args: string[], cwd: string, env: Record<string,string>, spawn?: Function, killGraceMs?: number }} o
 */
export function startSession(o) {
  const spawn = o.spawn ?? ((c, a, opts) => nodeSpawn(c, [...a], opts));
  const sup = startChild({ spawn, command: o.claudePath, args: o.args, options: { cwd: o.cwd, env: { ...o.env }, stdio: ["pipe", "pipe", "pipe"] }, killGraceMs: o.killGraceMs ?? 2000 });
  const { child } = sup;
  const events = [];
  let waiter;
  let exited = false;
  let tooLarge = false;
  const stream = createJsonLineStream({
    maxBytes: MAX_STDOUT_BYTES,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === "result" && waiter) waiter.done();
    },
    onTooLarge: () => {
      tooLarge = true;
      waiter?.done();
    },
    onError: () => waiter?.done(),
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c) => stream.push(c));
  child.stderr?.resume(); // never read: it may quote config or content
  child.stdin?.on("error", () => {});
  child.once("exit", () => {
    exited = true;
    waiter?.done();
  });
  const tree = child.pid === undefined ? undefined : new OwnedTree(child.pid);
  let closing;

  return {
    pid: child.pid,
    events,
    get exited() {
      return exited;
    },
    /** Record the process tree now (for the cleanup evidence). */
    pollTree() {
      tree?.poll(psSnapshot());
    },
    /** Send one message; resolves `{ events, result, timedOut, exited, ms }` for this turn. */
    send(text, { timeoutMs }) {
      const from = events.length;
      const t0 = Date.now();
      return new Promise((resolve) => {
        const finish = (timedOut) => {
          clearTimeout(timer);
          waiter = undefined;
          const turn = events.slice(from);
          resolve({ events: turn, result: turn.findLast((e) => e.type === "result"), timedOut, exited, tooLarge, ms: Date.now() - t0 });
        };
        const timer = setTimeout(() => finish(true), timeoutMs);
        waiter = { done: () => finish(false) };
        if (exited) return finish(false);
        child.stdin?.write(userMessage(text));
      });
    },
    /** Stop the session now (abort path): terminate its process group; close() still reaps. */
    terminate() {
      tree?.poll(psSnapshot());
      if (!exited) sup.terminate();
    },
    /** End stdin, wait for exit, then terminate and reap whatever remains. Returns tree evidence. Idempotent. */
    close() {
      return (closing ??= doClose());
    },
  };

  async function doClose() {
    tree?.poll(psSnapshot());
    child.stdin?.end();
    const exitedCleanly = exited || (await Promise.race([new Promise((r) => child.once("exit", () => r(true))), new Promise((r) => setTimeout(() => r(false), EXIT_WAIT_MS))]));
    if (!exitedCleanly) sup.terminate();
    await sup.waitExit();
    await sup.drainOutput();
    stream.end();
    await sup.reap();
    sup.dispose();
    const remaining = tree ? tree.alive(psSnapshot()).length : 0;
    return { exitedOnStdinEnd: exitedCleanly, processesSeen: tree?.identities().length ?? 0, processesRemaining: remaining };
  }
}
