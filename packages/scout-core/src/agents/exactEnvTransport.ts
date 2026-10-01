// A stdio MCP client transport whose child gets exactly the environment it is given. Used
// by the per-job bridge (contextToolBridge.ts) to start each backend.

import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** A backend line longer than this closes that backend. */
export const BACKEND_MAX_LINE_BYTES = 1024 * 1024;

/**
 * Like the SDK's StdioClientTransport, except the child gets exactly `env` (the SDK's merges
 * in HOME, PATH, USER, ... from this process), its stderr is discarded, its cwd is `/` unless
 * the reviewed definition names one, and
 * one oversized line closes it.
 */
export class ExactEnvStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private proc: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: BACKEND_MAX_LINE_BYTES });

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env: Readonly<Record<string, string>>,
    private readonly cwd: string = "/",
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, [...this.args], { env: { ...this.env }, cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false });
      this.proc = proc;
      proc.on("error", (e) => {
        reject(e);
        this.onerror?.(e);
      });
      proc.once("spawn", () => resolve());
      proc.once("close", () => {
        this.proc = undefined;
        this.onclose?.();
      });
      proc.stdin?.on("error", () => {});
      proc.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) this.onmessage?.(m);
        } catch (e) {
          this.onerror?.(e as Error);
          void this.close();
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const proc = this.proc;
    if (!proc?.stdin || proc.stdin.destroyed) return Promise.reject(new Error("not connected"));
    return new Promise((resolve) => (proc.stdin!.write(serializeMessage(message)) ? resolve() : proc.stdin!.once("drain", () => resolve())));
  }

  /** SIGTERM, then SIGKILL after 1 s if it is still there. */
  async close(): Promise<void> {
    const proc = this.proc;
    this.buffer.clear();
    if (!proc) return;
    proc.stdin?.end();
    try {
      proc.kill("SIGTERM");
    } catch {
      // gone
    }
    setTimeout(() => this.killNow(proc), 1000).unref();
  }

  /** Synchronous SIGKILL, for process exit. */
  killNow(proc: ChildProcess | undefined = this.proc): void {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}
