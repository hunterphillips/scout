export { type Clock, systemClock } from "./clock.js";
export {
  createDiagnostics,
  defaultDiagnosticsPath,
  scoutHome,
  type DiagnosticFields,
  type Diagnostics,
  type DiagnosticsOptions,
} from "./diagnostics.js";
export {
  createResumeCache,
  RESUME_TTL_MS,
  type ContextStatus,
  type ResumeCache,
  type ResumeCacheOptions,
  type ResumeKey,
  type ResumeMissReason,
} from "./resumeCache.js";
export {
  CHROME_BUNDLE_ID,
  createVisitTracker,
  WINDOW_ID_NONE,
  type VisitChange,
  type VisitTracker,
  type VisitTrackerOptions,
} from "./visitTracker.js";
export {
  createActivityForwarder,
  type ActivityForwarder,
  type ActivityForwarderOptions,
  type ActivitySend,
} from "./activityForwarder.js";
export {
  createCoordinator,
  type Coordinator,
  type CoordinatorConfig,
  type CoordinatorOptions,
} from "./coordinator.js";
export {
  createSocketServer,
  ensurePrivateRunDir,
  HELLO_TIMEOUT_MS,
  SOCKET_NAME,
  SocketServerError,
  type SocketClient,
  type SocketServer,
  type SocketServerErrorCode,
  type SocketServerOptions,
} from "./socketServer.js";
export { ConfigError, type CoreConfig, DEFAULT_DESTINATIONS, readConfig, readDestinations } from "./config.js";
export { runStdio, type StdioCore, type StdioDeps } from "./main.js";
export { SCOUT_VERSION } from "./version.js";
export {
  DEFAULT_ACCEPT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  SCOUT_USER_AGENT,
  type FetchLike,
  type GuardedFetchErrorReason,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  type GuardedRequestInit,
  type HostLookup,
} from "./fetch/guardedFetch.js";
export { isDisallowedAddress } from "./fetch/ipAddressPolicy.js";
export { type CatalogFetch, SITEMAP_MAX_BYTES, TEXT_SOURCE_MAX_BYTES } from "./catalog/catalogFetch.js";
export { MAX_URL_LENGTH, sameOriginAbsoluteHttpsUrl, sameOriginHttpsUrl } from "./catalog/sameOrigin.js";
export { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX, SANITIZE_INPUT_FACTOR, sanitizeLabel } from "./catalog/sanitizeLabel.js";
export {
  compileRobots,
  fetchRobots,
  isAllowed,
  MAX_CRAWL_DELAY_MS,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULES,
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
export { type CatalogFetchOptions } from "./catalog/catalogFetch.js";
export {
  createPacedCatalogFetch,
  MAX_REQUESTS_PER_RUN,
  RUN_DEADLINE_MS,
  type PacedCatalogFetch,
  type PacedCatalogFetchOptions,
  type Sleep,
} from "./catalog/pacing.js";
export {
  discoverCatalog,
  MAX_CANDIDATES,
  MAX_LABEL_BYTES,
  MAX_ROBOTS_CHECKS,
  normalizeUrl,
  slugTitle,
  TRACKING_PARAMS,
  type CatalogResource,
  type DiscoverOptions,
  type Discovery,
  type DiscoveryStats,
} from "./catalog/resolver.js";
export {
  cacheFileName,
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
