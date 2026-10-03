export { type Clock, systemClock, systemTimers } from "./clock.js";
export {
  createDiagnostics,
  defaultDiagnosticsPath,
  scoutHome,
  type DiagnosticFields,
  type Diagnostics,
  type DiagnosticsOptions,
} from "./diagnostics.js";
export { createJobResumeCache, RESUME_TTL_MS, type JobResumeCache, type JobResumeKey, type ResumeCacheOptions } from "./resumeCache.js";
export {
  CHROME_BUNDLE_ID,
  createVisitTracker,
  WINDOW_ID_NONE,
  type VisitChange,
  type VisitTracker,
  type VisitTrackerOptions,
} from "./visitTracker.js";
export {
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_TTL_MS,
  canonicalIssueUrl,
  createActivityStore,
  type ActivityAcceptResult,
  type ActivityStore,
  type StoredActivity,
} from "./activity/store.js";
export {
  createSnapshotRegistry,
  snapshotCandidates,
  type JobSnapshot,
  type SnapshotCandidate,
  type SnapshotRegistry,
  type SnapshotRegistryOptions,
  type SnapshotReleaseReason,
  type SnapshotVersion,
  type TakeSnapshotInput,
} from "./activity/snapshots.js";
export {
  createCoordinator,
  type Coordinator,
  type CoordinatorCapabilities,
  type CoordinatorConfig,
  type CoordinatorOptions,
} from "./coordinator.js";
export {
  createDwellScheduler,
  DWELL_MS,
  type DwellCancelReason,
  type DwellScheduler,
  type DwellSchedulerOptions,
} from "./dwell.js";
export { createPermissionState, GITHUB_ORIGIN, patternToOrigin, type PermissionState } from "./permissionState.js";
export {
  createSocketServer,
  ensurePrivateRunDir,
  HELLO_TIMEOUT_MS,
  SOCKET_NAME,
  SocketServerError,
  type RefusedCommandFrame,
  type SocketClient,
  type SocketClientFrame,
  type SocketServer,
  type SocketServerErrorCode,
  type SocketServerOptions,
} from "./socketServer.js";
export { ConfigError, type CoreConfig, DEFAULT_DESTINATIONS, readConfig, readDestinations } from "./config.js";
export { runStdio, type StdioCore, type StdioDeps } from "./main.js";
export { createPanelSinks, type PanelSink, type PanelSinks, type PanelSinksOptions } from "./panelSinks.js";
export { SCOUT_VERSION } from "./version.js";
export {
  DEFAULT_ACCEPT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  SCOUT_USER_AGENT,
  type GuardedFetch,
  type GuardedFetchErrorReason,
  type GuardedFetchOptions,
  type GuardedFetchResult,
} from "./fetch/guardedFetch.js";
export { isDisallowedAddress } from "./fetch/ipAddressPolicy.js";
export { type CatalogFetch, type CatalogFetchOptions, SITEMAP_MAX_BYTES, TEXT_SOURCE_MAX_BYTES } from "./catalog/catalogFetch.js";
export { MAX_URL_LENGTH, sameOriginAbsoluteHttpsUrl, sameOriginHttpsUrl } from "./catalog/sameOrigin.js";
export { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX, SANITIZE_INPUT_FACTOR, sanitizeLabel } from "./catalog/sanitizeLabel.js";
export {
  compileRobots,
  fetchRobots,
  isAllowed,
  MAX_CRAWL_DELAY_MS,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULES,
  MAX_WILDCARDS_PER_RULE,
  parseRobots,
  ROBOTS_PRODUCT_TOKEN,
  type CompiledRobots,
  type FetchedRobots,
  type RobotsRule,
  type RobotsRules,
  type RobotsSource,
} from "./catalog/robots.js";
export {
  fetchLlmsTxt,
  MAX_NESTED_LLMS_TXT,
  parseLlmsTxt,
  type FetchedLlmsTxt,
  type LlmsTxtEntry,
  type ParsedLlmsTxt,
} from "./catalog/llmsTxt.js";
export {
  fetchSitemaps,
  MAX_ROOT_SITEMAPS,
  MAX_SITEMAP_ENTRIES,
  MAX_SITEMAP_INDEX_CHILDREN,
  parseSitemap,
  type FetchedSitemaps,
  type FetchSitemapsOptions,
  type ParsedSitemap,
  type SitemapCounters,
  type SitemapEntry,
  type SitemapImage,
  type SitemapRejectReason,
  type SitemapUrl,
} from "./catalog/sitemap.js";
export {
  createPacedCatalogFetch,
  isRefusal,
  MAX_REQUESTS_PER_RUN,
  RUN_DEADLINE_MS,
  type PacedCatalogFetch,
  type PacedCatalogFetchOptions,
  type PacedFetch,
  type Sleep,
} from "./catalog/pacing.js";
export {
  discoverCatalog,
  MAX_CANDIDATES,
  MAX_LABEL_BYTES,
  MAX_ROBOTS_CHECKS,
  MAX_ROBOTS_WORK,
  normalizeUrl,
  slugTitle,
  TRACKING_PARAMS,
  type CatalogResource,
  type DiscoverOptions,
  type Discovery,
  type DiscoveryStats,
} from "./catalog/resolver.js";
export { CACHE_STALE_MAX_MS, cacheFileName } from "./privateCacheFile.js";
export {
  CATALOG_CACHE_SCHEMA_VERSION,
  CATALOG_FRESH_MS,
  CATALOG_FUTURE_TOLERANCE_MS,
  CATALOG_STALE_MAX_MS,
  createCatalogCache,
  type CatalogCache,
  type CatalogCacheFile,
  type CatalogCacheOptions,
  type CatalogCacheResult,
  type CatalogCacheSource,
  type ResolveWithCacheOptions,
} from "./catalog/cache.js";
export {
  createOriginFetchSession,
  type OriginFetchSession,
  type OriginFetchSessionOptions,
  type OriginFetchStats,
} from "./fetch/originSession.js";
export {
  createCatalogResolver,
  type CatalogResolution,
  type CatalogResolveStats,
  type CatalogResolver,
  type CatalogResolverOptions,
} from "./catalog/resolveCatalog.js";
export { decodeEntities } from "./catalog/entities.js";
export {
  extractDisplayTitle,
  TITLE_SCAN_CHARS,
  VERIFY_BUDGET_MS,
  VERIFY_MAX_BYTES,
  VERIFY_MAX_CANDIDATES,
  verifyTargets,
  type VerifiedCandidate,
  type VerifyDropReason,
  type VerifyFetch,
  type VerifyOptions,
  type VerifyResult,
} from "./catalog/verifyTargets.js";
