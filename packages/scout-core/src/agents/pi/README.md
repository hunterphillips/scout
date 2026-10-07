# Pi adapter

This folder runs Scout's recommendation jobs through Pi: one `pi --mode json --no-session` per job, with the prompt on stdin. It implements `AgentJobAdapter` (`../adapter.ts`); `../registry.ts` builds it for a profile whose `adapter` is `pi`.

Each job gets a private `PI_CODING_AGENT_DIR` in its job dir (`userAgentDir.ts`, `launch.ts`). It holds `auth.json`, a symlink to the user's own, so a token refresh reaches the user's file; `models.json`, a symlink when the user has one; a `settings.json` with only the user's `deviceId`, `defaultProvider`, `defaultModel` and `enabledModels`; and an `mcp.json` with Scout's servers at `exposure: "direct"`. The job uses the provider and model the user's Pi would pick, unless the profile names `provider/model`. The child env is `FORWARD_KEYS` plus Pi's own variables, so no API key reaches a job from the environment; jobs use what `auth.json` holds. User extensions, skills, prompt templates, themes and context files are off, and `--tools` lists the exact surface.

Pi has no output-schema flag. `answerExtension.mjs`, the only extension loaded, registers a `scout_answer` tool whose parameters are the job's JSON Schema; Pi validates the arguments and ends the run on the call. Its result also counts the Scout tools Pi loaded, because a Scout server that fails to start is silent in JSON mode.

Readiness (`readiness.ts`, in a forked child) runs only `pi --version` and `pi --list-models` in a throwaway agent dir: no model call, no network. A job needs a login or key for at least one model, and for the profile's model when it names one.

Pi's JSON mode exits 0 after a model error, so `eventMonitor.ts` and `mapOutcome.ts` read the outcome from the event stream: the first accepted answer, a tool outside the surface, the 16-turn cap, or the assistant's error and stop reason. Argv verified against Pi 1.0.4.

`testing/` holds the scripted fake `pi` (`fake-pi.mjs`: `--mode json`, `--version`, `--list-models`, `mcp add|remove|list`).
