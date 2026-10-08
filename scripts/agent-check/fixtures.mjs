// The synthetic world for a compatibility check: a throwaway Scout home, a private temp
// root, a fixture Scout core on a Unix socket, and the synthetic tools and job request.
// Everything here is made up; no browsing, personal source or real site is involved, except
// what the maintainer passes to the baseline case with --candidates and --activity.

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { createFixtureBackend } from "../../packages/scout-mcp/dist/fixture.js";
import { serveFixture } from "../../packages/scout-mcp/dist/test-support/fixtureSocket.js";
import { DEFAULT_CLAUDE_CODE_MODEL } from "../../packages/scout-core/dist/agents/claudeCode/profile.js";
import { DEFAULT_CODEX_MODEL } from "../../packages/scout-core/dist/agents/codex/profile.js";
import { DEFAULT_PI_THINKING } from "../../packages/scout-core/dist/agents/pi/profile.js";
import { schemaHash } from "../../packages/scout-core/dist/agents/toolProfile.js";
import { ActivityEntrySchema, CandidateSchema, JOB_MAX_CANDIDATES, RECENT_ACTIVITY_MAX_LIMIT } from "../../packages/contracts/dist/index.js";

export const SCOUT_MCP_MAIN = join(REPO_ROOT, "packages", "scout-mcp", "dist", "main.js");
/** The synthetic stdio backend (honest mode) used as the user's selected tool. */
export const FAKE_BACKEND = join(REPO_ROOT, "packages", "scout-core", "src", "agents", "testing", "fake-backend.mjs");
export const CHECK_MODEL = DEFAULT_CLAUDE_CODE_MODEL;
/** The model a check's profile names, per adapter. */
export const checkModel = (adapter = "claude-code") => (adapter === "codex" ? DEFAULT_CODEX_MODEL : adapter === "pi" ? undefined : CHECK_MODEL);
/** Reserved for documentation (RFC 6761), so nothing real is ever named. */
export const SKILL_SITE = "https://scout-proof.example";
export const JOB_SITE = "https://docs.example.com";

const newToken = () => randomBytes(24).toString("base64url");

/**
 * Check `--home` and create it (0700) if missing. Refuses a relative path, the real Scout
 * home (`~/.scout`) or anything inside it, and a path that is not a private directory.
 * With `dryRun`, nothing is created.
 */
export function prepareCheckHome(home, { env = process.env, dryRun = false } = {}) {
  if (typeof home !== "string" || !isAbsolute(home)) throw new Error("--home must be an absolute path");
  const real = resolve(join(env.HOME || homedir(), ".scout"));
  const rel = relative(real, resolve(home));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("--home must be a throwaway directory, not the real Scout home");
  let st;
  try {
    st = lstatSync(home);
  } catch {
    if (!dryRun) mkdirSync(home, { recursive: true, mode: 0o700 });
    return { created: !dryRun };
  }
  const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
  if (!st.isDirectory() || !owned || (st.mode & 0o077) !== 0) throw new Error("--home must be a private (0700) directory owned by this user");
  return { created: false };
}

/**
 * A private (0700) temp dir, resolved through symlinks so paths are exact. Falls back to
 * /tmp when the system temp dir is too deep for a Unix socket path (104 bytes on macOS).
 */
export function makeThrowawayRoot(prefix) {
  const base = realpathSync(tmpdir()).length > 70 ? "/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, prefix)));
  chmodSync(root, 0o700);
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

async function serve(root, seed) {
  const backend = await createFixtureBackend(seed);
  const socketPath = join(root, "a.sock");
  const socket = await serveFixture(backend, socketPath);
  const tokenFile = join(root, "agent-token");
  writeFileSync(tokenFile, `${seed.token}\n`, { mode: 0o600, flag: "wx" });
  return { backend, socket, socketPath, tokenFile };
}

/**
 * One approved synthetic `skill` resource whose text carries a fresh proof phrase, so an
 * answer that quotes it shows the resource was read, not just listed.
 */
export async function startSkillFixture(root) {
  const token = newToken();
  const proofPhrase = `SCOUT-PROOF-${randomBytes(6).toString("hex")}`;
  const text = `# Synthetic Scout check resource\n\nThis is fixture text for a Scout compatibility check. It describes nothing real.\n\nProof phrase: ${proofPhrase}\n`;
  const { backend, socket, socketPath, tokenFile } = await serve(root, {
    coreInstanceId: "core-check",
    token,
    resources: [{ kind: "skill", siteOrigin: SKILL_SITE, sourceUrl: `${SKILL_SITE}/skills/proof.md`, versions: [{ text, state: "approved" }] }],
  });
  const resourceId = backend.resourceIds[0];
  return {
    token,
    proofPhrase,
    socketPath,
    tokenFile,
    resourceId,
    version: backend.versionHashes(resourceId)[0],
    publisherOrigin: SKILL_SITE,
    /** read_resource requests the fixture received. */
    reads: () => socket.requests.filter((r) => r.method === "read_resource").length,
    revoke: () => backend.revoke(resourceId),
    openConnections: () => socket.openConnections,
    close: () => socket.close(),
  };
}

/** Synthetic candidates; c1 is the one the browser context makes relevant. */
export const JOB_CANDIDATES = Object.freeze([
  { id: "c1", title: "Usage-based billing guide", description: "Meter API calls and invoice customers monthly", labelQuality: "published" },
  { id: "c2", title: "Careers", description: "Open roles", labelQuality: "published" },
  { id: "c3", title: "Brand assets", description: "Logos and colors", labelQuality: "published" },
  { id: "c4", title: "System status", labelQuality: "slug" },
  { id: "c5", title: "Team offsite photos", labelQuality: "image_title" },
  { id: "c6", title: "Press kit", labelQuality: "slug" },
]);

function readJsonFile(file, flag) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${flag} must name a readable JSON file`);
  }
}

/** `schema.parse(value)`, or an Error naming the flag and the first problem's path. */
function parseWith(schema, value, flag) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const at = issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
  throw new Error(`${flag}: ${at ? `${at.replace(/^\./, "")}: ` : ""}${issue.message}`);
}

const httpsOrigin = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A real case for the baseline check, in place of the synthetic one.
 *
 * `candidatesFile`: a Scout catalog cache file (`~/.scout/cache/catalog/<host>-<hash>.json`),
 * its `catalog` object (`{ origin, version, candidates }`), or a plain array of candidates (the
 * site is the first one's origin). Candidates are checked against the contracts'
 * CandidateSchema, 1-500 of them, ids unique. `activityFile`: a JSON array of 1-10 pages,
 * `{ url, title, text? }`, newest first, checked against ActivityEntrySchema (title 300
 * characters, text 8 KiB). Either may be omitted; the synthetic one is used then.
 */
export function loadCaseInputs({ candidatesFile, activityFile } = {}) {
  const inputs = {};
  if (candidatesFile) {
    const raw = readJsonFile(candidatesFile, "--candidates");
    const cat = Array.isArray(raw) ? { candidates: raw } : (raw?.catalog ?? raw);
    const candidates = parseWith(CandidateSchema.array().min(1).max(JOB_MAX_CANDIDATES), cat?.candidates, "--candidates");
    if (new Set(candidates.map((c) => c.id)).size !== candidates.length) throw new Error("--candidates: duplicate candidate id");
    const origin = httpsOrigin(cat.origin ?? candidates[0].sourceUrl);
    if (!origin) throw new Error("--candidates: the catalog has no https origin");
    inputs.site = {
      origin,
      catalogVersion: typeof cat.version === "string" && cat.version ? cat.version : "case-catalog",
      candidates: candidates.map((c) => ({ id: c.id, sourceUrl: c.sourceUrl, title: c.title, ...(c.description !== undefined ? { description: c.description } : {}), labelQuality: c.labelQuality })),
    };
  }
  if (activityFile) {
    const list = readJsonFile(activityFile, "--activity");
    if (!Array.isArray(list)) throw new Error("--activity: must be a JSON array of { url, title, text } pages");
    const now = Date.now();
    const entries = list.map((a, i) => {
      const origin = httpsOrigin(a?.url);
      if (!origin) throw new Error(`--activity: [${i}].url: not an https URL`);
      return {
        origin,
        url: a.url,
        observedAt: now - (i + 1) * 60_000,
        title: a.title,
        ...(a.text !== undefined ? { text: a.text } : {}),
        textTruncated: false,
      };
    });
    inputs.activity = parseWith(ActivityEntrySchema.array().min(1).max(RECENT_ACTIVITY_MAX_LIMIT), entries, "--activity");
  }
  return inputs;
}

/**
 * The fixture core for a background job: a current site and recent activity that point at c1,
 * or, with `inputs` from loadCaseInputs, the case's site (its root page and its links) and pages.
 */
export async function startJobFixture(root, inputs = {}) {
  const token = newToken();
  const site = inputs.site;
  const served = await serve(root, {
    coreInstanceId: "core-check",
    token,
    browserContextGranted: true,
    currentSite: site
      ? { origin: site.origin, url: `${site.origin}/`, title: new URL(site.origin).host, visitEpoch: 7 }
      : { origin: JOB_SITE, url: `${JOB_SITE}/billing`, title: "Billing documentation", visitEpoch: 7 },
    ...(site
      ? { siteLinks: { origin: site.origin, catalogVersion: site.catalogVersion, links: site.candidates.map((c) => ({ id: c.id, href: c.sourceUrl, title: c.title, ...(c.description ? { description: c.description } : {}) })) } }
      : {}),
    activity: inputs.activity ?? [
      {
        origin: "https://linear.app",
        url: "https://linear.app/example-org/issue/API-42/usage-based-billing",
        observedAt: Date.now() - 60_000,
        title: "Charge customers per API call",
        text: "Synthetic issue: we need usage-based billing. Meter each API call and send customers a monthly invoice.",
        textTruncated: false,
      },
    ],
  });
  return {
    token,
    socketPath: served.socketPath,
    coreInstanceId: "core-check",
    openConnections: () => served.socket.openConnections,
    close: () => served.socket.close(),
  };
}

/** A background job request over JOB_CANDIDATES, or the case's site, for the given profile. */
export function jobRequest({ requestId, coreInstanceId, profileFingerprint, site }) {
  return {
    requestId,
    coreInstanceId,
    visitEpoch: 7,
    origin: site?.origin ?? JOB_SITE,
    catalogHash: "check-catalog-1",
    browserSnapshot: { id: "snap-check", revision: 1 },
    approvalRevision: 0,
    grantRevision: 0,
    profileFingerprint,
    deadlineMs: 30_000,
    candidates: site ? site.candidates.map(({ sourceUrl: _url, ...c }) => c) : JOB_CANDIDATES.map((c) => ({ ...c })),
    maxPicks: 3,
  };
}

const LOOKUP_SCHEMA = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };

/**
 * The selected-tool fixture: fake-backend.mjs (honest mode) as a reviewed stdio definition
 * with literal, synthetic env only, and one required selected tool, `lookup`, whose reply
 * carries a fresh proof phrase.
 */
export function selectedToolProfile(root) {
  const proofPhrase = `SCOUT-TOOL-${randomBytes(6).toString("hex")}`;
  const log = join(root, "backend.log");
  return {
    proofPhrase,
    log,
    tools: {
      connections: [
        {
          id: "check-notes",
          transport: "stdio",
          command: process.execPath,
          args: [FAKE_BACKEND, "--mode", "honest", "--log", log, "--proof", proofPhrase],
          env: {},
          literalEnv: { SCOUT_CHECK: "synthetic" },
        },
      ],
      selections: [
        {
          connectionId: "check-notes",
          toolName: "lookup",
          description: "Look up the user's current task notes (synthetic). Call it once with a short query before choosing.",
          inputSchema: LOOKUP_SCHEMA,
          schemaHash: schemaHash(LOOKUP_SCHEMA),
          required: true,
          unattendedReadDeclared: true,
          selectedAt: new Date().toISOString(),
        },
      ],
    },
  };
}

/** The agent profile a check writes into its throwaway home, for the adapter it checks. */
/** `piModel` (`provider/id`) pins a Pi check to one model; without it Pi uses the user's default. */
export function checkProfile(adapter, agentPath, tools, piModel) {
  const base = adapter === "codex" ? { schemaVersion: 1, adapter, codexPath: agentPath, model: checkModel(adapter) } : adapter === "pi" ? { schemaVersion: 1, adapter, piPath: agentPath, thinking: DEFAULT_PI_THINKING, ...(piModel ? { model: piModel } : {}) } : { schemaVersion: 1, adapter: "claude-code", claudePath: agentPath, model: CHECK_MODEL };
  return { ...base, ...(tools ? { tools } : {}) };
}
