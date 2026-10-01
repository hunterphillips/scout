// Test-only: synthetic connection definitions and tool selections for fake-backend.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaHash, type Connection, type ToolSelection } from "../toolProfile.js";

export const FAKE_BACKEND = fileURLToPath(new URL("./fake-backend.mjs", import.meta.url));

/** The schema fake-backend.mjs advertises for `lookup` in its honest modes. */
export const LOOKUP_SCHEMA = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
export const EMPTY_SCHEMA = { type: "object", properties: {} };

export interface BackendLogLine {
  pid?: number;
  env?: Record<string, string>;
  cwd?: string;
  method?: string;
  tool?: string;
  reply?: { method: string; error?: number };
}

export interface FakeBackendDef {
  connection: Connection;
  log: string;
  /** The user-owned definition file holding the literal env values (0600). */
  definitionFile: string;
  lines(): BackendLogLine[];
  pids(): number[];
  /** tools/call names the backend received. */
  calls(): string[];
}

/**
 * A reviewed stdio definition for fake-backend.mjs: `node fake-backend.mjs --mode <mode>`,
 * with `env` as literal values in a 0600 definition file under `dir`, bound by pointer, and
 * `literalEnv` stored in the definition itself.
 */
export function fakeBackend(dir: string, id: string, mode: string, opts: { env?: Record<string, string>; literalEnv?: Record<string, string>; touch?: string } = {}): FakeBackendDef {
  const log = join(dir, `${id}.log`);
  const definitionFile = join(dir, `${id}-definition.json`);
  const env = opts.env ?? {};
  writeFileSync(definitionFile, JSON.stringify({ command: process.execPath, env }), { mode: 0o600 });
  const args = [FAKE_BACKEND, "--mode", mode, "--log", log, ...(opts.touch ? ["--touch", opts.touch] : [])];
  const connection: Connection = {
    id,
    transport: "stdio",
    command: process.execPath,
    args,
    env: Object.fromEntries(Object.keys(env).map((k) => [k, { file: definitionFile, pointer: `/env/${k}` }])),
  };
  if (opts.literalEnv) connection.literalEnv = opts.literalEnv;
  const lines = (): BackendLogLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as BackendLogLine)
      : [];
  return {
    connection,
    log,
    definitionFile,
    lines,
    pids: () => lines().flatMap((l) => (typeof l.pid === "number" ? [l.pid] : [])),
    calls: () => lines().flatMap((l) => (l.method === "tools/call" && l.tool ? [l.tool] : [])),
  };
}

export function selection(connectionId: string, toolName: string, required: boolean, inputSchema: Record<string, unknown> = toolName === "lookup" ? LOOKUP_SCHEMA : EMPTY_SCHEMA): ToolSelection {
  return {
    connectionId,
    toolName,
    description: `Reviewed ${toolName}`,
    inputSchema: inputSchema as ToolSelection["inputSchema"],
    schemaHash: schemaHash(inputSchema),
    required,
    unattendedReadDeclared: true,
    selectedAt: "2026-10-01T12:00:00.000Z",
  };
}
