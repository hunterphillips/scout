# Agent compatibility checks

Two commands for Phase 1 of the website-agent plan.

- `npm run test:agent-contract` runs the hermetic tests: the job runtime and skill
  wrappers in scout-core, the scout-mcp adapter, and these scripts. The tests use a
  scripted fake `claude` (`packages/scout-core/src/agents/testing/fake-claude.mjs`) and
  temp dirs only.
- `npm run verify:agent -- --case <case> --home <dir> [options]` runs one live check
  against the installed Claude CLI. Every real run makes model calls on the user's
  subscription, so each one needs separate authorization. Build first (`npm run build`).

## Arguments

| Argument | Meaning |
| --- | --- |
| `--case <c>` | `hotload`, `baseline`, `selected-tool` or `cancel` (required) |
| `--home <dir>` | Throwaway Scout home, created 0700 if missing (required). The real `~/.scout` is refused. The report goes to `<dir>/agent-check/<case>-<timestamp>.json`. |
| `--dry-run` | Print the names, paths and argv of the run. Writes, registers and launches nothing, including the preflight. |
| `--max-inference <n>` | Most inference requests the run may make: default 2, maximum 4. A hotload run whose options need more is refused. |
| `--claude <path>` | Use this `claude` binary instead of the one on `PATH`. |
| `--authorize-real-root` | hotload: the acceptance run. Adds one `scout-proof-<nonce>` MCP registration at user scope and one `scout-proof-<nonce>` skill directory in the real user skills root (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`), and removes both afterwards. |
| `--preliminary` | hotload: put the skill in the throwaway cwd's `.claude/skills` and load the server with `--mcp-config`. Nothing installed changes; the result does not count for the gate. |
| `--with-revocation` | hotload: after the skill works, revoke the resource, remove the skill, and ask for one more read. Needs one more request. |
| `--two-session` | hotload: if turn 2 does not use the skill, try again in a fresh session, to tell "needs a restart" from "never works". Needs one more request. |

A hotload run without `--authorize-real-root` or `--preliminary` exits 2 and changes
nothing. The hot-load gate then stays unverified.

Exit codes: 0 the check passed (or a dry run), 1 the check failed or stopped, 2 refused.

## Invocations and inference requests

| Command | Requests |
| --- | --- |
| `npm run verify:agent -- --case hotload --home <dir> --authorize-real-root` | 2 |
| `... --case hotload --home <dir> --authorize-real-root --with-revocation --max-inference 3` | 3 |
| `... --case hotload --home <dir> --authorize-real-root --two-session --max-inference 3` | 2, or 3 if turn 2 fails |
| `... --case baseline --home <dir>` | 1 |
| `... --case selected-tool --home <dir>` | 1 |
| `... --case cancel --home <dir>` | 1 |

## What each case does

Every case runs the billing preflight for the exact environment, working directory and
binary it will launch, and launches nothing for inference unless the verdict is
`subscription`. The environment is the direct launch profile's filtered one.

**hotload.** Starts a fixture Scout core holding one approved synthetic skill resource
whose text has a fresh proof phrase. It registers the MCP server (`claude mcp add --scope
user`), then opens one headless session that stays open across turns
(`--input-format stream-json`). Turn 1 asks which `scout-proof-*` skills the session sees.
The proof skill is written after turn 1. Turn 2 asks the session to use it. The check
passes only if the session called the Skill tool with that name, read the resource
through the proof server, and quoted the proof phrase. Outcomes: `hotload_pass`,
`hotload_requires_reload` (turn 2 did not use the new skill), `mcp_requires_restart` (the
registration did not load in turn 1), `preflight_failed`, `aborted`.

Cleanup always runs. The skill directory is removed only if it still holds exactly the
`SKILL.md` that was written, by hash. The registration is removed only if `claude mcp
get` still shows the same command and args at user scope. Anything changed is left in
place and reported.

**baseline.** One background job through the real job adapter, with Scout context only.
Passes on `ok` with at least one pick and at least one Scout tool call.

**selected-tool.** The same job plus one selected synthetic tool: `fake-backend.mjs`
behind the per-job bridge, with literal env only. Passes when the job called
`mcp__scout_bridge__lookup` and the backend logged the call.

**cancel.** Starts a job and cancels it 3 seconds after its init event. Passes when the
job reports `cancelled`, no process from its tree is left, the fixture has no open
connection, and the job dir is gone.

## The report

The JSON report records the CLI version, effective argv, preflight verdict and reason
codes, the env filtering applied (forwarded key names and a count of dropped keys), what
the init event loaded, the model, the outcome, the structured output, timings, usage
counts, cleanup evidence, and each inference request. Scout's own servers, tools and
skills are named. The user's other servers, tools and skills are only counted. Tokens, env
values and prompts never appear, and paths under `$HOME` are written as `~`. The
proof phrase is replaced by `<proof phrase>` in quoted model text.
