// Whether run/server.json describes the service actually listening on its port.
//
// A pid alone is not proof: after a SIGKILL the file stays behind, and the OS may hand the
// pid to an unrelated process. Ownership means connecting to the file's port with the
// token and getting back a context_status whose serviceInstanceId equals the file's. The
// server uses this before refusing to start, and `pcm status` / `pcm reload` before
// reporting a live service or sending it a signal.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ContextStatusSchema, type ContextStatus } from "./api.js";
import type { ServerInfo } from "./serviceFiles.js";

export const PROBE_TIMEOUT_MS = 2_000;

/**
 * The live service's context_status when `info` names it, else undefined (nothing
 * listening, a different listener, a wrong instance id, or no answer within `timeoutMs`).
 * Never throws.
 */
export async function probeService(info: ServerInfo, token: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ContextStatus | undefined> {
  let transport: StreamableHTTPClientTransport;
  try {
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
  } catch {
    return undefined;
  }
  const client = new Client({ name: "pcm-probe", version: "0.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
  });
  const attempt = (async (): Promise<ContextStatus | undefined> => {
    try {
      await client.connect(transport as Transport, { timeout: timeoutMs });
      const res = await client.callTool({ name: "context_status", arguments: {} }, undefined, { timeout: timeoutMs });
      const parsed = ContextStatusSchema.safeParse(res.structuredContent);
      return parsed.success && parsed.data.serviceInstanceId === info.serviceInstanceId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  })();
  const outcome = await Promise.race([attempt, timedOut]);
  clearTimeout(timer);
  if (outcome !== "timeout" && outcome !== undefined) {
    // Only a listener that answered gets a DELETE; a silent one could hold it open.
    await Promise.race([transport.terminateSession().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
  // Aborts any request still in flight, so a silent listener never keeps us alive.
  await client.close().catch(() => {});
  return outcome === "timeout" ? undefined : outcome;
}
