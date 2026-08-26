/**
 * @repo/observability
 *
 * Centralized observability package for Fabric applications.
 *
 * Quick Start:
 * ```typescript
 * import { initObservability, llmInstrumentation, databaseInstrumentation } from '@repo/observability';
 *
 * // Initialize once at startup
 * initObservability({ serviceName: 'my-service' });
 *
 * // Use instrumentation in your code
 * const result = await llmInstrumentation.trace('chat', {
 *   provider: 'anthropic',
 *   model: 'claude-3-sonnet',
 * }, async (span) => {
 *   const response = await anthropic.messages.create({...});
 *   span.setTokenUsage(response.usage.input_tokens, response.usage.output_tokens);
 *   return response;
 * });
 * ```
 */

// Azure Application Insights — metrics + alerting backend.
// Replaces the deleted self-hosted Prometheus + Alertmanager stack.
export {
	__resetAppInsightsForTests,
	getAppInsightsClient,
	initAppInsights,
	trackEvent,
	trackMetric,
} from "./lib/app-insights";
// Application error-rate + integration metrics
export {
	appErrorsTotal,
	BreakerStateValue,
	type ErrorClassLabel,
	type FeatureLabel,
	type HttpStatusClassLabel,
	httpRequestsTotal,
	organizationLabel,
	PERSONAL_ORG_LABEL,
	type ProviderOutcomeLabel,
	providerBreakerState,
	providerRequestTotal,
	type ServiceLabel,
	type SyntheticProbeOutcomeLabel,
	statusCodeToClass,
	syntheticProbeDuration,
	syntheticProbeResult,
} from "./lib/app-metrics";
// Cockatiel circuit breakers.
// Wraps every MVP-5 provider SDK call to emit `provider_request_total`
// increments and `provider_breaker_state` transitions.
export {
	__resetBreakersForTests,
	getBreaker,
	isRateLimit,
	type WithProviderBreakerOutcome,
	withProviderBreaker,
} from "./lib/breakers";
// Error classifier — maps thrown values onto bounded error_class labels.
export { classifyError } from "./lib/error-class";
// Monitoring v2 feature flags — gates incident UI,
// banners, and burn-rate Alertmanager rules during phased rollout.
export {
	getMonitoringFeatureFlags,
	isMonitoringFeatureEnabled,
	MONITORING_FEATURE_ENV_VARS,
	MONITORING_FEATURE_FLAGS,
	type MonitoringFeatureFlag,
	parseFlagValue,
} from "./lib/feature-flags";
// Core initialization
export {
	getLogger,
	getMeter,
	getTracer,
	initObservability,
	isObservabilityInitialized,
	type ObservabilityConfig,
	shutdownObservability,
} from "./lib/init";
// Instrumentation modules
export {
	type ApiCallOptions,
	type DatabaseTraceOptions,
	databaseInstrumentation,
	type EmbeddingOptions,
	type HttpSpan,
	httpInstrumentation,
	type LLMCallOptions,
	type LLMSpan,
	llmInstrumentation,
	ragInstrumentation,
	type VectorSearchOptions,
	type VectorSearchSpan,
} from "./lib/instrumentations";
// Integration provider registry.
// Concrete registrations live in `./lib/integration-providers.ts` and
// are pulled in for side effects by this side-effect import.
// Any consumer importing from `@repo/observability` automatically gets
// the registry populated — callers don't have to know about the
// `integration-providers.ts` file at all.
//
// The DB sync helper used to live here as `ensureProviderRegistryUpserted`
// but has been relocated to `@repo/database` as
// `syncIntegrationProviderRegistry(getRegisteredProviders())` to break
// the package-level cycle:
//   `@repo/observability → @repo/database → @repo/storage → @repo/observability`
import "./lib/integration-providers";

// Platform component registry — Fabric's own subsystems, as a customer sees
// them. Same side-effect-import pattern as the provider registry above, so any
// consumer importing from `@repo/observability` gets it populated.
//
// Unlike the provider registry there is deliberately NO database mirror: health
// is resolved server-side per request, so nothing outside the API process ever
// needs to read this table-that-doesn't-exist. See `platform-components.ts`.
import "./lib/platform-component-registrations";

export {
	__resetRegistryForTests,
	getProvidersForPolling,
	getProvidersForSyntheticProbe,
	getRegistration,
	type IntegrationProviderRegistration,
	// `getRegisteredProviders` is the public, intent-revealing alias of
	// `listRegistrations` used by cross-package callers (e.g.
	// `@repo/api`'s boot path that bridges the in-memory TS registry into
	// the `@repo/database` sync helper).
	listRegistrations as getRegisteredProviders,
	listRegistrations,
	registerIntegrationProvider,
	type SyntheticProbeConfig,
} from "./lib/integration-registry";
// Legacy Prometheus metrics (for /api/metrics endpoint)
export * from "./lib/metrics";
// Metrics scrape route helpers.
export {
	createMetricsHttpServer,
	type MetricsHttpServerOptions,
	mountMetricsRoute,
} from "./lib/metrics-route";
export {
	__resetPlatformComponentsForTests,
	getIncidentKeyOwners,
	listCustomerVisibleComponents,
	listPlatformComponents,
	type PlatformComponentGroup,
	type PlatformComponentRegistration,
	type PlatformComponentSignal,
	registerPlatformComponent,
} from "./lib/platform-components";

// Legacy tracing exports (deprecated - use initObservability instead)
export { initializeTracing, trace, withSpan } from "./lib/tracing";
