# Agent compatibility checks

Two commands for Phase 1 of the website-agent plan.

- `npm run test:agent-contract` runs the hermetic tests: the job runtime and skill
  wrappers in scout-core, the scout-mcp adapter, and these scripts. The tests use a
  scripted fake `claude` (`packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs`), a scripted fake `codex` (`packages/scout-core/src/agents/codex/testing/fake-codex.mjs`), a scripted fake `pi` (`packages/scout-core/src/agents/pi/testing/fake-pi.mjs`) and
  temp dirs only.
- `npm run verify:agent -- --case <case> --home <dir> [options]` runs one live check
  against the installed Claude CLI. Every real run makes model calls on the user's
  subscription, so each one needs separate authorization. Build first (`npm run build`).

`node scripts/agent-check/codex-probe.mjs --home <dir> [--run] [--codex <path>] [--model <m>]
[--variant no-approval-mode|shell-on]` runs one `codex exec` job against the fixture Scout core, to
see how the Codex CLI behaves before a Codex adapter exists. Without `--run` it prints the argv
and env key names and exits. With `--run` it makes one inference request on the user's ChatGPT
plan, so each run needs separate authorization. It refuses the real `~/.scout`, any
`CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` or `OPENAI_API_KEY` in the env (exit 2), and a login that
`codex login status` does not report as ChatGPT (exit 3). Codex gets its own `CODEX_HOME` under
`<dir>/run/codex-home` whose `auth.json` is a symlink to the user's. The run writes
`<dir>/probe/events.jsonl`, `stderr.log` and `summary.json` (item counts, Scout tool calls without
arguments, the final output, usage, and whether Codex touched the user's `auth.json`).

## Arguments

| Argument | Meaning |
| --- | --- |
| `--case <c>` | `hotload`, `baseline`, `selected-tool` or `cancel` (required) |
| `--home <dir>` | Throwaway Scout home, created 0700 if missing (required). The real `~/.scout` is refused. The report goes to `<dir>/agent-check/<case>-<timestamp>.json`. |
| `--dry-run` | Print the names, paths and argv of the run. Writes, registers and launches nothing, including the preflight. |
| `--max-inference <n>` | Most inference requests the run may make: default 2, maximum 4. Above 2 needs `--acknowledge-budget`. A hotload run whose options need more is refused. |
| `--acknowledge-budget` | Allow `--max-inference` above 2. Without it such a run exits 2, because the plan allows "at most two inference requests in one authorized check". |
| `--adapter <id>` | `claude-code` (default), `codex` or `pi`. `codex` and `pi` run `baseline`, `selected-tool` and `cancel` through that adapter; `hotload` is Claude Code only. |
| `--claude <path>` | Use this `claude` binary instead of the one on `PATH`. |
| `--codex <path>` | With `--adapter codex`: use this `codex` binary instead of the one on `PATH`. |
| `--pi <path>` | With `--adapter pi`: use this `pi` binary instead of the one on `PATH`. |
| `--pi-model <provider/id>` | With `--adapter pi`: pin the model. Without it the job uses the model your Pi would pick. |
| `--candidates <file>` | baseline: the site's links, in place of the six synthetic ones. A Scout catalog cache file (`~/.scout/cache/catalog/<host>-<hash>.json`), its `catalog` object, or a plain JSON array of candidates (the site is then the first one's origin). Each candidate must match the contracts' `CandidateSchema` (`id`, `sourceUrl`, `title` up to 160 characters, optional `description`, `labelQuality`, `provenance`); 1 to 500 of them, ids unique. The fixture core serves them as the current site's links, at the site's root page. |
| `--activity <file>` | baseline: the user's recent pages, in place of the synthetic tracker issue. A JSON array of 1 to 10 `{ "url", "title", "text" }` objects, newest first: an https `url`, `title` up to 300 characters, optional `text` up to 8 KiB. |
| `--authorize-real-root` | hotload: the acceptance run. Adds one `scout-proof-<nonce>` MCP registration at user scope and one `scout-proof-<nonce>` skill directory in the real user skills root (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`), and removes both afterwards. |
| `--preliminary` | hotload: put the skill in the throwaway cwd's `.claude/skills` and load the server with `--mcp-config`. Nothing installed changes; the result does not count for the gate. |
| `--with-revocation` | hotload: after the skill works, revoke the resource, remove the skill, and ask for one more read. Needs one more request. |
| `--two-session` | hotload: if turn 1 shows the proof server `failed` or `absent`, or turn 2 does not invoke the skill, try again in a fresh session, to tell "needs a restart" from "never works". Needs one more request. |

A hotload run without `--authorize-real-root` or `--preliminary` exits 2 and changes
nothing. The hot-load gate then stays unverified. A missing user skills root is refused,
never created.

Exit codes: 0 the check passed (or a dry run), 1 the check failed or stopped, 2 refused.

SIGINT, SIGTERM or SIGHUP during a run stops the session, runs the same cleanup as a normal end
(once; a second signal is ignored), writes the report with outcome `aborted`, and exits 1.
An uncaught exception or unhandled rejection is treated the same way, and the report's
failure code adds the error's name and code (`aborted_uncaughtException_TypeError`). A third
signal is not handled either. SIGKILL is the only escape, and it skips cleanup.

One inference request is one user turn: one message sent to the hotload session, or one
background job. Each can make several API calls when the model uses tools, up to
`--max-turns`; the report counts them per turn in `turns[].usage.turns`. Run revocation
(`--with-revocation`) and the restart check (`--two-session`) as separate checks rather than
one acknowledged run of 3 or 4.

During an acceptance run, close other Claude Code sessions if possible: they can write the
same user config file. The report records whether the registry changed underneath us.

## Invocations and inference requests

| Command | Requests |
| --- | --- |
| `npm run verify:agent -- --case hotload --home <dir> --authorize-real-root` | 2 |
| `... --case hotload --home <dir> --authorize-real-root --with-revocation --max-inference 3 --acknowledge-budget` | 3 |
| `... --case hotload --home <dir> --authorize-real-root --two-session --max-inference 3 --acknowledge-budget` | 2, or 3 if turn 2 fails |
| `... --case baseline --home <dir>` | 1 |
| `... --case baseline --home <dir> --candidates <file> --activity <file>` | 1 |
| `... --case selected-tool --home <dir>` | 1 |
| `... --case cancel --home <dir>` | 1 |
| `... --case baseline --home <dir> --adapter codex` (also `selected-tool`, `cancel`) | 1 |
| `... --case baseline --home <dir> --adapter pi` (also `selected-tool`, `cancel`) | 1 |

## What each case does

Every case runs the billing preflight for the exact environment, working directory and
binary it will launch, and launches nothing for inference unless the verdict is
`subscription`. The environment is the direct launch profile's filtered one.

**hotload.** Starts a fixture Scout core holding one approved synthetic skill resource
whose text has a fresh proof phrase. It registers the MCP server (`claude mcp add --scope
user`), then opens one headless `claude -p` process that stays open across turns
(`--input-format stream-json --output-format stream-json`). This process stands in for an
interactive session; it is not one, and the report says so. Turn 1 asks which
`scout-proof-*` skills the session sees. The proof skill is written after turn 1. Turn 2
asks the session to list the `scout-proof-*` skills it sees and, if it lists one, to use it
and quote the proof phrase. Turn 2's prompt does not name the skill.

The session loads every user-scope MCP server and plugin, because the user-scope proof
registration is only visible with user settings loaded. The report counts them and never
names them. These flags limit what the model can do: `--tools Skill,ToolSearch`,
`--settings {"disableAllHooks":true}`, `--setting-sources user`, `--permission-mode
dontAsk` with `--allowedTools` set to `Skill`, `ToolSearch` and the proof server's two
tools, and `--max-turns 8`. Other servers' tools are loaded but not allowed, so `dontAsk`
denies them.

`ToolSearch` is offered because, from the 2.1.286 binary, the CLI defers MCP tools behind
tool search whenever `ToolSearch` is available. The init event may still list a deferred
tool, so the report records `mcpToolsDeferred` (the proof server connected but its tools
were not listed in init) and `toolSearch.uses`.

MCP startup is also non-blocking in 2.1.286, so a server still starting shows `pending` in
the init event. The check records `mcpStatusAtInit` and goes on to turn 2 without polling
or extra waiting; turn 2's latency is the wait, and its evidence decides the outcome. Only
`failed` and `absent` (and other statuses that are not timing) stop the check after turn 1.

Outcomes, each from the session's own events:

| Outcome | Evidence |
| --- | --- |
| `hotload_pass` | Turn 2 listed the proof skill, invoked it with the Skill tool, read the resource through the proof server, and quoted the proof phrase. |
| `skill_used_not_listed` | All of the above, but the skill was missing from the model's own list. |
| `read_ok_phrase_missing` | The read succeeded; the final reply has no proof phrase. |
| `skill_invoked_read_failed` | The Skill tool was called; `read_resource` was not called or returned an error (`readError` holds the code). |
| `skill_not_invoked` | No Skill call names the proof skill. |
| `hotload_requires_reload` | `--two-session`: turn 2 did not invoke it; a fresh session did, and read it. The billing preflight runs again before the fresh session opens; if it fails, no second session starts. |
| `skill_never_loads` | `--two-session`: neither session invoked and read it. |
| `mcp_not_loaded` | Turn 1's init showed the proof server `failed` or `absent`, and the check stopped there. Or init showed it `pending` or `connected_without_tools`, the check went on, and in turn 2 `read_resource` failed as `tool_unavailable` or `server_not_connected`, or the skill was invoked and no read followed. `mcpStatusAtInit` holds the init status. |
| `mcp_requires_restart` | `--two-session`: the server was `failed` or `absent` in the first session and connected in a fresh one. |
| `preflight_failed`, `aborted` | The billing preflight did not return `subscription`; the run stopped (signal, timeout, or error). |

Cleanup always runs. The skill directory is removed only if it still holds exactly the
`SKILL.md` that was written, by hash. The registration is removed only if `claude mcp
get` still shows the same command and args at user scope. That check runs even when `mcp
add` failed or timed out, since it may have written the entry first. Anything changed is
left in place and reported. `get` counts as "absent" only when it exits 1 with the CLI's
"No MCP server named ..." message. A timeout, a signal or any other error leaves the entry
alone and reports `unknown_state` with the exit status or signal. A removal that `get`
cannot confirm is reported as `removal_unverified`. Either way cleanup is marked
incomplete.

Each cleanup step runs even if an earlier one fails: sessions, skill directory,
registration, fixture, throwaway dir. A failed step records `error_<code>` (for example
`error_EACCES`) and the report is still written. A skill directory replaced by a symlink is
left in place as `left_symlink`.

Before `mcp add`, the check reads the key names of `mcpServers` in the user config
(`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`); it never reads or keeps the
values. After cleanup it reads them again and runs `mcp get` once more about 3 seconds
later. `registry` reports the counts before and after, `foreignChanged` (another writer
changed other entries), and `reappeared` (our entry came back after removal, which fails the
check).

With `--adapter codex`, the check runs Codex's readiness check instead (`codex --version`,
`codex login status`) and launches nothing unless it reports a login. With `--adapter pi`,
it runs `pi --version` and `pi --list-models` and launches nothing unless a model has
credentials. The report's
`init` records only that `thread.started` arrived; the cancel case counts its 3 seconds from
that event.

**baseline.** One background job through the real job adapter, with Scout context only.
Passes on `ok` with at least one pick and at least one Scout tool call. With
`--candidates` and `--activity` it runs on a real case instead: a site's catalog and the
pages the user read. A file that does not fit the contracts is refused (exit 2) before
anything runs, and `--dry-run` prints each file's path and count. For example:

    npm run verify:agent -- --case baseline --adapter codex --home /tmp/scout-check \
      --candidates ~/.scout/cache/catalog/stripe.com-1a2b3c.json --activity ./activity.json

The report lists each pick's candidate title and URL next to its id and reason, so the
picks can be judged against the case.

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
skills are named. The user's other servers, tools and skills are only counted, and so are
the user's allow rules (`userAllowRules`). Tokens, env values, prompts and model text never
appear; each turn keeps only the `scout-proof-*` names the model listed, outcome flags and
fixed codes. Paths under `$HOME` are written as `~`.
