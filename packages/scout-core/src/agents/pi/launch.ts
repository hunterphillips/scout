// How one Pi job is launched. The job's 0700 directory contains `agent-token`,
// `answer-schema.json`, optional `bridge.json`, and `pi-agent/`. The agent dir holds only:
// `auth.json` -> the user's private login, optional `models.json` -> the user's model file,
// a 0600 settings.json, and a 0600 mcp.json with Scout's direct-exposure servers. From the
// user's settings.json, userAgentDir.ts copies only deviceId, defaultProvider,
// defaultModel and enabledModels. The job directory and its symlinks die after the run.
//
// Pi 1.0.4 argv (verified by the probe):
//   --mode json                 one-shot JSON event stream, prompt on stdin
//   --no-session               do not save conversation history
//   -na                         no project .pi config
//   -ns                         no user or shared skills
//   -nc                         no parent AGENTS.md or CLAUDE.md context
//   -np                         no prompt templates
//   --no-themes                no user theme loading
//   -e <answerExtension.mjs>   the only extension; registers scout_answer
//   --tools <exact list>       Scout MCP tools, optional bridge glob, scout_answer
//   [--model provider/id]      only when the profile explicitly sets a model
//   --thinking <level>         profile level or DEFAULT_PI_THINKING
//   --append-system-prompt     Scout's job instructions and answer-tool rule
//
// The child env forwards only FORWARD_KEYS. Added keys:
//   PATH                        CLI dir, core-node dir, then the forwarded parent PATH
//   PI_CODING_AGENT_DIR         the job's private Pi agent dir
//   SCOUT_PI_ANSWER_SCHEMA      the job's answer-schema.json
//   PI_SKIP_VERSION_CHECK=1     no update check
//   PI_TELEMETRY=0              no telemetry

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRequestIdSchema, JOB_AGENT_OUTPUT_JSON_SCHEMA } from "@scout/contracts";
import { ensureAgentCwd } from "../../localSocketFiles.js";
import type { JobToolSurface } from "../adapter.js";
import type { BridgeJob } from "../contextToolBridge.js";
import { isExecutableFile, pathWithDirs, type Env } from "../executables.js";
import type { Out } from "../jobStop.js";
import { buildJobSurface, defaultScoutMcpEntrypoint, type JobSurface } from "../claudeCode/jobSurface.js";
import { ensureJobsRoot, FORWARD_KEYS } from "../claudeCode/launchProfile.js";
import { defaultBridgeEntrypoint, planJobTools, type ToolPlanOptions, type UnavailableTool } from "../claudeCode/toolPolicy.js";
import { buildJobInstructions } from "../prompt.js";
import { DEFAULT_PI_THINKING, type PiProfile } from "./profile.js";
import { ensurePiAgentDir, userPiAgentDir } from "./userAgentDir.js";

export const JOB_FILES = Object.freeze({
  token: "agent-token",
  schema: "answer-schema.json",
  bridge: "bridge.json",
  agent: "pi-agent",
});
export const ANSWER_EXTENSION = fileURLToPath(new URL("./answerExtension.mjs", import.meta.url));
export const JOB_MAX_TURNS = 16;

/** The allowlisted job and readiness env, with Pi and the core's node on PATH. */
export function piChildEnv(
  parentEnv: Env,
  piPath: string,
  agentDir: string,
  schemaFile: string,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of FORWARD_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = pathWithDirs([dirname(piPath), dirname(process.execPath)], env.PATH);
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.SCOUT_PI_ANSWER_SCHEMA = schemaFile;
  return Object.freeze(env);
}

export interface PiArgvOptions {
  profile: PiProfile;
  surface: Pick<JobSurface, "expected">;
  /** Test seam; production uses the bundled extension next to the built module. */
  extension?: string;
}

/** The single permitted Pi launch shape, with no inherited tools or sessions. */
export function buildPiArgv(o: PiArgvOptions): string[] {
  const scout = o.surface.expected.find((server) => server.name === "scout");
  if (!scout) throw new Error("surface: missing scout");
  const bridge = o.surface.expected.some((server) => server.name === "scout_bridge");
  const tools = [
    ...scout.tools,
    ...(bridge ? ["mcp__scout_bridge__*"] : []),
    "scout_answer",
  ];
  const instructions = [
    buildJobInstructions(JOB_MAX_TURNS),
    "The structured output is the `scout_answer` tool: call it exactly once, as your last action, with your final answer. Do not answer in chat text.",
  ].join("\n");
  return [
    "--mode", "json",
    "--no-session",
    "-na", "-ns", "-nc", "-np",
    "--no-themes",
    "-e", o.extension ?? ANSWER_EXTENSION,
    "--tools", tools.join(","),
    ...(o.profile.model ? ["--model", o.profile.model] : []),
    "--thinking", o.profile.thinking ?? DEFAULT_PI_THINKING,
    "--append-system-prompt", instructions,
  ];
}

/** Data needed to prepare one Pi job. All paths passed to Pi are absolute. */
export interface PiLaunchOptions {
  home: string;
  profile: PiProfile;
  parentEnv: Env;
  requestId: string;
  surface: JobToolSurface;
  workspaceRoots?: readonly string[];
  nodePath?: string;
  scoutMcpEntrypoint?: string;
  bridgeEntrypoint?: string;
  bridgeLimits?: BridgeJob["limits"];
}

/** Prepared argv, env and private files; cleanup removes only this job's directory. */
export interface PiLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly jobDir: string;
  readonly toolSurface: JobSurface;
  readonly unavailable: readonly UnavailableTool[];
  cleanup(): void;
}

export type PiLaunchResult = { ok: true; launch: PiLaunch } | { ok: false; out: Out };

const failed = (result: Out["result"], termination: Out["termination"], detail: string): PiLaunchResult => ({
  ok: false,
  out: { result, termination, detail },
});

/** Create one exclusive job dir, its direct MCP config, schema, token and child launch. */
export function createPiLaunch(o: PiLaunchOptions): PiLaunchResult {
  const userDir = userPiAgentDir(o.parentEnv);
  if (!AgentRequestIdSchema.safeParse(o.requestId).success || !userDir) {
    return failed({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "launch_profile");
  }
  if (!isExecutableFile(o.profile.piPath)) {
    return failed({ status: "unavailable", reason: "agent_unavailable" }, "agent_unavailable", "launch_profile");
  }

  let cwd: string;
  let jobDir: string;
  try {
    cwd = ensureAgentCwd(o.home);
    jobDir = join(ensureJobsRoot(join(o.home, "run", "jobs"), o.workspaceRoots), o.requestId);
    mkdirSync(jobDir, { mode: 0o700 }); // exclusive; never reuse an existing job dir
  } catch {
    return failed({ status: "error", reason: "agent_failed" }, "process_error", "launch_profile");
  }

  const cleanup = (): void => rmSync(jobDir, { recursive: true, force: true });
  try {
    const agentDir = join(jobDir, JOB_FILES.agent);
    ensurePiAgentDir(agentDir, userDir);
    const nodePath = o.nodePath ?? process.execPath;
    const planOpts: ToolPlanOptions = {
      tools: o.profile.tools,
      scout: {
        nodePath,
        entrypoint: o.scoutMcpEntrypoint ?? defaultScoutMcpEntrypoint(),
        socketPath: o.surface.scout.socketPath,
        tokenFile: join(jobDir, JOB_FILES.token),
      },
      bridge: {
        nodePath,
        entrypoint: o.bridgeEntrypoint ?? defaultBridgeEntrypoint(),
        jobFile: join(jobDir, JOB_FILES.bridge),
      },
    };
    if (o.bridgeLimits) planOpts.limits = o.bridgeLimits;
    const plan = planJobTools(planOpts);
    if (!plan.ok) {
      cleanup();
      return failed({ status: "error", reason: plan.reason }, plan.reason, plan.detail);
    }

    const toolSurface = buildJobSurface(plan.spec);
    const mcpServers: Record<string, { command: string; args: string[]; exposure: "direct" }> = {};
    for (const server of toolSurface.expected) {
      const entry = toolSurface.mcpConfig.mcpServers[server.name];
      if (!entry || entry.env !== undefined) throw new Error("surface: unsupported server");
      mcpServers[server.name] = { command: entry.command, args: entry.args, exposure: "direct" };
    }

    const write = (path: string, data: string): void => {
      writeFileSync(path, data, { mode: 0o600, flag: "wx" });
    };
    write(join(jobDir, JOB_FILES.token), `${o.surface.scout.token}\n`);
    const schemaFile = join(jobDir, JOB_FILES.schema);
    write(schemaFile, JSON.stringify(JOB_AGENT_OUTPUT_JSON_SCHEMA));
    if (plan.bridgeJob) write(join(jobDir, JOB_FILES.bridge), JSON.stringify(plan.bridgeJob));
    write(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers }));

    const argv = buildPiArgv({ profile: o.profile, surface: toolSurface });
    const env = piChildEnv(o.parentEnv, o.profile.piPath, agentDir, schemaFile);
    return {
      ok: true,
      launch: Object.freeze({
        argv,
        env,
        cwd,
        jobDir,
        toolSurface,
        unavailable: plan.unavailable,
        cleanup,
      }),
    };
  } catch {
    cleanup();
    return failed({ status: "error", reason: "agent_failed" }, "process_error", "setup_failed");
  }
}
