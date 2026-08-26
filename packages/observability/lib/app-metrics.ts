/**
 * Application Error-Rate + Integration Metrics
 *
 * These metrics drive the error-rate burn-rate alerts and the integration
 * outage detection rules. They are exposed alongside the existing legacy
 * MCP metrics on the same `/api/metrics` endpoint.
 *
 * Cardinality budget: every label value is bounded. The full Cartesian
 * product across active labels must remain under 1,500 active series per
 * environment. Cardinality is policed by code review: any new label MUST
 * be enumerable and finite. Never label by raw userId, full URL paths, or
 * AI prompt strings.
 *
 * The metrics register on the SAME shared `register` instance exported by
 * `./metrics` so a single `register.metrics()` call exposes both legacy
 * and new metrics.
 */

import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "./metrics";

/**
 * Service slug — bounded enum of services that emit metrics.
 *
 * Cardinality: 5–8 values.
 */
export type ServiceLabel =
	| "api"
	| "temporal-worker"
	| "document-generator"
	| "project-doc-gen"
	| "task-planner"
	| "story-breakdown"
	| "data-analyst"
	| "api-agent"
	| "prompt-enhancer"
	| "backlog-updater"
	| "agent";

/**
 * Feature slug — bounded enum of feature surfaces that emit metrics.
 *
 * Cardinality: 6 values, fixed.
 */
export type FeatureLabel =
	| "ai_generation"
	| "payments"
	| "document_processing"
	| "pm_sync"
	| "auth"
	| "temporal_activity";

/**
 * Error class taxonomy — coarse-grained, bounded.
 *
 * Cardinality: 8 values, fixed.
 */
export type ErrorClassLabel =
	| "5xx"
	| "unhandled"
	| "timeout"
	| "activity_failure"
	| "validation"
	| "downstream_4xx"
	| "rate_limit"
	| "unknown";

/**
 * Provider request outcome — bounded enum.
 *
 * Cardinality: 4 values, fixed.
 */
export type ProviderOutcomeLabel =
	| "success"
	| "error"
	| "rate_limited"
	| "circuit_open";

/**
 * Synthetic probe outcome — bounded enum.
 *
 * Cardinality: 3 values, fixed.
 */
export type SyntheticProbeOutcomeLabel = "success" | "failure" | "timeout";

/**
 * HTTP status class — coarse bucket so cardinality stays bounded.
 *
 * Cardinality: 4 values, fixed. We deliberately do NOT label by raw
 * status code because that would multiply series by ~50 with most of
 * the values never firing in practice. The burn-rate denominator only
 * needs to know "did a request happen", so even the class is more
 * granularity than the rules strictly need — we keep it because the
 * dashboard occasionally splits success vs error totals.
 */
export type HttpStatusClassLabel = "2xx" | "3xx" | "4xx" | "5xx";

/**
 * The literal string emitted for the personal tenant in `organization_id`
 * labels. NEVER use "", null, or undefined — Prometheus would emit them as
 * empty-string labels which collide and confuse queries.
 */
export const PERSONAL_ORG_LABEL = "personal" as const;

/**
 * Resolve an organization ID into a Prometheus label value.
 *
 * - Org context: pass the org's cuid string. Returns it as-is.
 * - Personal context: pass `undefined`, `null`, `""`, or omit. Returns "personal".
 *
 * Never returns "", null, or undefined — prom-client would emit an empty
 * label which collides with the `"personal"` bucket and skews queries.
 */
export function organizationLabel(
	organizationId: string | null | undefined,
): string {
	if (organizationId === null || organizationId === undefined) {
		return PERSONAL_ORG_LABEL;
	}
	if (organizationId === "") {
		return PERSONAL_ORG_LABEL;
	}
	return organizationId;
}

// -----------------------------------------------------------------------------
// 1. app_errors_total — the single counter that drives error-rate alerts.
// -----------------------------------------------------------------------------
//
// Labels (all enumerable and bounded):
//   service        — see ServiceLabel
//   feature        — see FeatureLabel
//   error_class    — see ErrorClassLabel
//   organization_id — the org's ID, or the literal string "personal".
//                     NEVER raw userId (cardinality bomb).
//
// Maximum cardinality: ~8 services × 6 features × 8 error_classes × ~200 orgs
//   = ~76 800 active series in the worst case. Prometheus's "stale marker"
//   drops inactive tuples so steady state is far lower. Per-org isolation
//   is required for per-org rollups in the admin dashboard.
// -----------------------------------------------------------------------------
export const appErrorsTotal = new Counter({
	name: "app_errors_total",
	help: "Total application errors emitted from the hot path.",
	labelNames: [
		"service",
		"feature",
		"error_class",
		"organization_id",
	] as const,
	registers: [register],
});

// -----------------------------------------------------------------------------
// 2. provider_request_total — every outbound provider call (success and failure)
// -----------------------------------------------------------------------------
//
// Labels:
//   provider  — one of IntegrationProvider keys (registered via the registry).
//   operation — provider-specific operation name (e.g., "chat_completion",
//               "checkout_session_create", "send_email", "put_object").
//   outcome   — see ProviderOutcomeLabel.
//
// Wired into Cockatiel breakers and provider client wrappers.
// -----------------------------------------------------------------------------
export const providerRequestTotal = new Counter({
	name: "provider_request_total",
	help: "Total outbound provider requests, grouped by outcome.",
	labelNames: ["provider", "operation", "outcome"] as const,
	registers: [register],
});

// -----------------------------------------------------------------------------
// 3. provider_breaker_state — Cockatiel circuit breaker state changes
// -----------------------------------------------------------------------------
//
// Gauge values:
//   0 = closed (healthy)
//   1 = half-open (probing recovery)
//   2 = open (tripped, short-circuiting)
//
// Wired into the Cockatiel `onBreak` / `onHalfOpen` / `onReset` callbacks.
// Until then the gauge stays at its default (0) for every breaker; queries
// return no series until something writes.
// -----------------------------------------------------------------------------
export const providerBreakerState = new Gauge({
	name: "provider_breaker_state",
	help: "Cockatiel circuit breaker state (0=closed, 1=half-open, 2=open).",
	labelNames: ["provider", "breaker_key"] as const,
	registers: [register],
});

/**
 * Numeric encoding for the {@link providerBreakerState} gauge.
 *
 * Kept here so call sites that set the gauge stay readable
 * (`providerBreakerState.set({...}, BreakerStateValue.OPEN)`).
 */
export const BreakerStateValue = {
	CLOSED: 0,
	HALF_OPEN: 1,
	OPEN: 2,
} as const;

export type BreakerStateValue =
	(typeof BreakerStateValue)[keyof typeof BreakerStateValue];

// -----------------------------------------------------------------------------
// 4. synthetic_probe_result_total — result of synthetic provider probes (MVP-5)
// -----------------------------------------------------------------------------
//
// Labels:
//   provider — one of the MVP-5 keys (stripe, openai, anthropic, resend, s3).
//   outcome  — see SyntheticProbeOutcomeLabel.
//
// Wired into the synthetic probe Temporal activities.
// -----------------------------------------------------------------------------
export const syntheticProbeResult = new Counter({
	name: "synthetic_probe_result_total",
	help: "Result of synthetic probes run from Temporal cron.",
	labelNames: ["provider", "outcome"] as const,
	registers: [register],
});

// -----------------------------------------------------------------------------
// 5. synthetic_probe_duration_seconds — probe latency histogram
// -----------------------------------------------------------------------------
export const syntheticProbeDuration = new Histogram({
	name: "synthetic_probe_duration_seconds",
	help: "Duration of synthetic probe calls.",
	labelNames: ["provider"] as const,
	buckets: [0.1, 0.5, 1, 2.5, 5, 10],
	registers: [register],
});

// -----------------------------------------------------------------------------
// 6. http_requests_total — denominator for burn-rate error ratios
// -----------------------------------------------------------------------------
//
// The burn-rate alert rules in `deployment/prometheus/rules/app-errors.yml`
// compute `app_errors_total / http_requests_total` over multiple windows.
// Without this counter the ratio resolves to `NaN` and no burn-rate alert
// can fire. The counter increments once per inbound HTTP request from the
// oRPC request-counter middleware, and once per Temporal activity attempt
// from `with-error-metric.ts` (activities ARE requests in our SLO model).
//
// Labels (all enumerable and bounded):
//   service       — see ServiceLabel
//   feature       — see FeatureLabel
//   method        — HTTP verb, or "TEMPORAL" for activity attempts. ~6 values.
//   route         — route TEMPLATE (e.g., "/api/orpc/incidents.list"),
//                   NEVER an actual path with IDs. Activities use their
//                   activity name as the route template.
//   status_class  — see HttpStatusClassLabel
//
// Cardinality budget: ~8 services × 6 features × 6 methods × ~30 routes ×
//   4 status_classes ≈ 34 560 worst-case. Steady-state is ~100 series.
//
// SAFETY: callers MUST pass a route TEMPLATE, never `request.url`. The
// request-counter middleware extracts the oRPC procedure path (already
// templated by construction). Adding a raw URL here is a cardinality
// bomb and a review-blocker.
// -----------------------------------------------------------------------------
export const httpRequestsTotal = new Counter({
	name: "http_requests_total",
	help: "Total HTTP requests / Temporal activity attempts — denominator for burn-rate alerts.",
	labelNames: [
		"service",
		"feature",
		"method",
		"route",
		"status_class",
	] as const,
	registers: [register],
});

/**
 * Map an HTTP status code into a {@link HttpStatusClassLabel} bucket.
 *
 * Status codes outside the 100–599 range fall back to "5xx" so any
 * upstream weirdness (gateways returning 0, etc.) still increments
 * something rather than silently dropping a request from the denominator.
 */
export function statusCodeToClass(status: number): HttpStatusClassLabel {
	if (status >= 200 && status < 300) {
		return "2xx";
	}
	if (status >= 300 && status < 400) {
		return "3xx";
	}
	if (status >= 400 && status < 500) {
		return "4xx";
	}
	return "5xx";
}
