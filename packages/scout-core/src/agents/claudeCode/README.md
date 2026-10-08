# Claude Code adapter

This folder runs Scout's recommendation jobs through Claude Code (`claude -p`). It is one agent adapter; the rest of the core never imports from it except through `../registry.ts` and the profile union in `../profile.ts`. The Codex adapter (`../codex/`) reuses its tool surface (`jobSurface.ts`, `planJobTools` in `toolPolicy.ts`) and its env allowlist and jobs-root check (`launchProfile.ts`).

An adapter provides:

- a strict profile schema with its own `adapter` id, added to `AgentProfileSchema` in `../profile.ts`;
- a factory returning an `AgentJobAdapter` (`../adapter.ts`): `id`, `profileFingerprint`, `readiness` and `refreshReadiness()` (whether inference may run now), `run()` (one job, ending in a `HostJobResult`), and `abortAll()`;
- a case in `createJobAdapter` in `../registry.ts`. The switch is exhaustive, so a new profile member does not compile until the registry knows it.

Jobs run on the profile's `model` (default `claude-haiku-5-5`) at the profile's `reasoningEffort`, passed as `--effort` (default `low`; `low`, `medium`, `high`, `xhigh` or `max`).

`testing/` holds the scripted fake `claude` CLI the tests use.
