# Codex adapter

This folder runs Scout's recommendation jobs through the Codex CLI: one `codex exec --ephemeral` per job, read-only sandbox, shell and web search off, Scout's MCP server (and the per-job bridge for selected tools) passed as `-c mcp_servers.*` overrides. It implements `AgentJobAdapter` (`../adapter.ts`); `../registry.ts` builds it for a profile whose `adapter` is `codex`.

Jobs run with `CODEX_HOME` set to Scout's private home, `SCOUT_HOME/run/codex-home`. It holds only Codex's caches and `auth.json`, a symlink to the user's own `~/.codex/auth.json`, so a token refresh reaches the user's file. Each job's SQLite state lives in its job dir and is removed with it.

A job runs only when `codex login status` reports a login and the auth link is intact (`readiness.ts`). The child env never carries `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` or `OPENAI_API_KEY`, so the login in `auth.json` is the one jobs use.

Codex sends the output schema as an OpenAI strict schema, so `outputSchema.ts` requires both fields and has no length or pattern limits. The empty answer comes back as `{"status":"empty","items":[]}` and is normalized before the usual validation.

`profile.ts` holds the union member, the Settings label, the default profile and the usual install locations the core searches after PATH; `../registry.ts` switches on all of them, so a new adapter does not compile until it adds its cases.

`testing/` holds the scripted fake `codex` the tests use (`fake-codex.mjs` for `exec`, `--version` and `login status`; `fake-codex-mcp.mjs` for `mcp add|get|remove` against a temp Codex home).
