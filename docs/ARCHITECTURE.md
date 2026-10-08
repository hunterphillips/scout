# Scout architecture

Scout has six pieces: a Chrome extension, a native-messaging relay, a Node core, an MCP
adapter, shared contracts, and a Mac menu-bar app. The core owns all state and decisions.
The other pieces carry messages to and from it.

```text
Chrome extension -> Chrome-started relay -> Scout core -> side panel (via the relay)
macOS app -> Scout core (stdio: launch, pause/resume, shutdown, frontmost app)
User's agent -> Scout MCP adapter -> Scout core's approved information (agent.sock)
Scout core -> fresh agent job -> validated result -> side panel
                  |
                  +-> Scout MCP tools and other permitted agent tools
```

## Components

**Chrome extension** (`packages/browser-extension`). The MV3 extension has two parts. Its
background worker is the sensor: it reports the focused tab's origin, Chrome's per-site
permissions, and (on github.com, while it is allowed) issue text. Its side panel is Scout's
only user interface, with four destinations: Page, Sites, Activity, Settings. The panel
renders frames from the core and sends commands back. It holds no state of its own beyond
a repaint cache.

**Native-messaging relay** (`packages/native-host`). Chrome starts this process when the
extension connects. It checks the caller's origin, opens `core.sock`, and re-encodes
validated frames in both directions. It forwards commands to the core only after the
core's first `capture_policy` arrives. It refuses the stdio-only commands (`frontmost`,
`shutdown`) by schema.

**Scout core** (`packages/scout-core`). The core tracks permissions and visits,
runs discovery against allowed sites, keeps the capability store, schedules
recommendation jobs, drives the panel channel, and serves `agent.sock`. Every outbound
HTTP request goes through one guarded fetch boundary under `src/fetch/`.

**MCP adapter** (`packages/scout-mcp`). A stdio MCP server the user's agent loads as
`scout`. It connects to `agent.sock`, checks the socket's ownership before sending the
token, and exposes the core's read-only calls as tools. It depends only on the contracts
package and the MCP SDK.

**Contracts** (`packages/contracts`). The zod schemas and types for every message between
pieces, plus the length-prefixed frame codec. Panel fixtures in
`packages/contracts/fixtures/panel/` pin the wire format.

**Mac menu-bar app** (`native/Scout`). A Swift app with a status item and no window. It
launches the core with `--stdio`, restarts it on crash (at most three times per 60 s), and
reports the frontmost app. The menu shows a status line, Pause/Resume, and Quit. Quit
sends `shutdown` and waits for the core to exit.

## Sockets

The core publishes two Unix sockets in `~/.scout/run/`. The directory is 0700, and each
socket is 0600 before it becomes visible.

`core.sock` connects the relay to the core. It carries sensor frames (permissions, focus,
page text) core-ward, `capture_policy` and panel frames Chrome-ward, and panel commands
with their acks. It speaks bridge protocol 4: page text comes from any page on a granted
site, and the permissions snapshot is just the granted origins. A relay or extension on
another protocol gets `upgrade_required`.

`agent.sock` is the MCP adapter's read-only protocol. A client opens with `hello` and the
token from `run/agent-token`, which the core rotates on every start. The calls are
`current_site`, `recent_activity`, `site_links`, `list_resources`, and `read_resource`.
Requests are capped at 16 KiB and responses at 64 KiB. For the user's interactive agent,
`current_site`, `recent_activity`, and `site_links` answer only while browser context is
switched on and Scout is not paused. A recommendation job connects with its own job token
and reads a frozen snapshot of its visit instead.

## Job lifecycle

1. A visit forms when the focused tab is on an allowed https origin. It settles after a
   3 s dwell. Switching to another app keeps the visit; coming back to another page ends it.
2. A settled visit starts a discovery pass. One pass runs at a time, the latest visit
   wins, and a visit change cancels the pass. The pass builds the site's catalog of
   candidate links and checks for agent files.
3. If suggestions are on for the site, the scheduler starts a recommendation job. The core
   runs one job at a time. A visit change cancels it, and the new visit gets one
   replacement. A page's answer is kept for 15 min after its visit ends: a later visit to
   it with the same catalog, approvals, grant and profile gets the answer back with no job.
   A page Scout opened from its own links gets no job for 15 min. The job's recent activity
   never includes the current page (other pages on the same site are included), and a
   capture of the current page never cancels or replaces its job.
4. The scheduler's states run `beginJob → working → take → run → idle → publish`. Every
   stage checks that the visit is still current.
5. The job adapter launches a fresh agent process with Scout's MCP tools and any tools the
   user selected in the agent profile. The agent returns 1 to 3 picks or `empty`.
6. The core validates each pick against the catalog and verifies at most three same-origin
   targets over the network. Results keep the hrefs. Frames sent to the panel carry only
   result ids, and the panel opens a link by id.

## Consent model

- Chrome's optional per-site permission gates everything. The extension posts nothing
  until the core sends `capture_policy`. It reports url and title only for origins Chrome
  has granted. A Chrome all-sites grant counts as not granted.
- Granting a site also allows reading its pages. The core keeps text only from pages on
  granted origins, only in memory. When a permissions snapshot drops a site, that site's
  pages leave the activity buffer and the others stay; a snapshot with no sites clears it.
  Pause and disconnect keep it.
- Approvals bind to one exact content version, identified by its hash. A changed file is
  a new version and needs a new decision.
- Revoking removes the exported skill wrapper and cancels a running job that used the
  resource.
- Auto-approve is a separate per-site switch, off by default, with its own confirmation.
- Suggestions are a separate per-site switch ("Suggest on <host>"), off by default.
- The agent's read of browser context (current site and recent activity) is a separate
  switch in Settings, off by default.

## Integration seam

Scout is agent-agnostic. Agent-specific code lives in two places:

- `packages/scout-core/src/agents/<adapter>/` implements `AgentJobAdapter` from
  `agents/adapter.ts`: `id`, `profileFingerprint`, `readiness`, `refreshReadiness`, `run`,
  `abortAll`.
- `packages/scout-core/src/integrations/<adapter>/` holds install-time wiring, such as
  exporting approved skills where the agent finds them.

`agents/registry.ts` builds the adapter with `createJobAdapter`, an exhaustive switch on
`profile.adapter`. The profile file `~/.scout/agent-profile.json` is a discriminated union
on `adapter` (`AgentProfileSchema` in `agents/profile.ts`). Three adapters exist: Claude
Code (`agents/claudeCode/`, with the skill-export integration in
`integrations/claudeCode/`), Codex (`agents/codex/`) and Pi (`agents/pi/`). Each runs a
readiness check in a separate child process before any job: the CLI is installed and
logged in.

The Claude Code adapter runs one `claude -p` per job with a strict MCP config, an exact
`--allowedTools` list, hooks off, and no session persistence.

The Codex adapter runs one `codex exec --ephemeral` per job in a read-only sandbox with
the shell, web search and apps off, and Scout's MCP server passed as `-c mcp_servers.*`
overrides. Jobs get a private `CODEX_HOME` (`~/.scout/run/codex-home`) that holds only
Codex's caches and an `auth.json` symlink to the user's own; each job's SQLite state lives
in its job dir.

The Pi adapter runs one `pi --mode json --no-session` per job with a private
`PI_CODING_AGENT_DIR` in the job dir: an `auth.json` symlink (and `models.json` when the
user has one), the user's model-selection settings, and Scout's MCP servers at
`exposure: "direct"`. User extensions, skills, prompt templates and context files are off,
and `--tools` lists the exact tool surface. Pi has no output-schema flag, so a bundled Pi
extension registers a `scout_answer` tool whose arguments Pi validates against the job's
JSON Schema; the answer also reports how many Scout tools loaded, which catches a Scout
server that failed to start (silent in Pi's JSON mode).

The user picks the agent in the side panel's Settings. The `capabilities` frame lists the
adapters whose CLI the core found (PATH, then each agent's usual install locations) and
the current one; `set_agent` writes that adapter's default profile under the core's
profile lock, keeping any selected tools. The profile watcher then swaps the adapter, the
same path a hand edit of the file takes.

## Shutdown

Every trigger (stdin EOF, `shutdown`, SIGTERM/SIGINT/SIGHUP) runs one sequence: stop
accepting, kill the readiness child, abort running jobs (SIGTERM, SIGKILL after 2 s, then
tracked descendants), then close parsers, sockets and the store. After a 5 s deadline the
core releases its locks, token and sockets synchronously and kills tracked survivors. Each
job dir holds a `tree.json` of its processes, so the next start can sweep leftovers.

## Diagnostics

The core appends events to `~/.scout/logs/diagnostics.jsonl`. Fields are scalars only:
counts, epochs, codes and origins, never page text, titles, full URLs, prompts or tokens.
The main events are `catalog_discover`, `catalog_cache`, `job_started`, `job_finished`,
`job_cancelled`, `agent_preflight` and `agent_job` (both with `adapter`),
`agent_profile_switched`, `jobs_swept` and `capability_decision`.

## Limits

| Area | Limit |
| --- | --- |
| Native frames | 4-byte length prefix; 64 KiB in; 16 KiB out, 1 MiB for panel frames |
| Core → relay writer | Drops non-ack panel frames above a 2 MiB high-water mark, repaints on drain |
| Mac app stdio | JSONL lines up to 1 MiB; command lines under 512 bytes |
| `agent.sock` | 16 KiB in, 64 KiB out, 16 KiB chunks; `hello` within 5 s |
| Preview stream | 16 KiB chunks; SHA-256 checked before Approve |
| Catalog | ≤500 candidates, 256 KiB; `llms.txt` nested one level, ≤5 files |
| Sitemaps | ≤5 roots; index ≤10 children, depth 1; ≤50,000 entries |
| Catalog cache | Fresh 24 h, then conditional probes; stale up to 7 days |
| Fetch policy | HTTPS only; same-host redirects ≤3; 8 s deadline; 2 MiB decoded body; private, loopback, link-local, CGNAT, NAT64 and 6to4 ranges blocked; URLs ≤2048 chars |
| Fetch pacing | Serial per origin, honours crawl delay; 128 requests and 90 s per window |
| Target verification | ≤3 targets in parallel, 4 s each |
| Activity buffer | ≤10 pages, 15 min TTL; 300-char title, 8 KiB text, URL ≤2048 chars |
| Job tokens | ≤256 live; page answers 15 min, ≤32 |
| Read audit | 200 entries |
| Panel commands | 10 s expiry; 256-entry ack route map |
| Shutdown | 5 s deadline, then forced release |
