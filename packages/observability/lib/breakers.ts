/**
 * Cockatiel Circuit Breaker integration
 *
 * One `CircuitBreakerPolicy` per provider key, cached in a module-scoped
 * `Map`. The policy uses `ConsecutiveBreaker(5)` and a 30s open duration
 * before the half-open trial.
 *
 * Public surface:
 *
 *   getBreaker(providerKey)   → CircuitBreakerPolicy, lazily created and
 *                                cached. State changes fan-out to the
 *                                `provider_breaker_state` gauge.
 *
 *   withProviderBreaker(...)  → Helper that wraps any async function with
 *                                the provider's breaker AND records the
 *                                outcome on `provider_request_total`. This
 *                                is the call site primitive every provider
 *                                client wrapper uses.
 *
 *   isRateLimit(err)          → Permissive HTTP-429 / SDK rate-limit
 *                                predicate. Exported so call-site code can
 *                                short-circuit retry loops with the same
 *                                logic the metric labels use.
 *
 * The breakers in this module are NOT reset between calls — they hold
 * cumulative state across the lifetime of the process. One breaker per
 * provider is the correct shape: every call to the provider funnels
 * through the same circuit so the consecutive-failure counter is
 * meaningful.
 *
 * State propagation to the gauge uses the Cockatiel `onBreak`,
 * `onHalfOpen`, and `onReset` events. Each callback writes the matching
 * `BreakerStateValue` to `providerBreakerState` with the provider key
 * and breaker key labels.
 *
 * Logging uses `console.info` directly at INFO level on every state
 * transition. The log includes the provider key, breaker key, and new
 * state name so operators can correlate metrics ↔ logs. We deliberately
 * do NOT depend on `@repo/logs` — that risks a circular dep with
 * services that already depend on `@repo/observability` (same rationale
 * applies to the DB-sync helper which now lives in `@repo/database`).
 */

import {
	type CircuitBreakerPolicy,
	ConsecutiveBreaker,
	circuitBreaker,
	handleAll,
	isBrokenCircuitError,
	isIsolatedCircuitError,
} from "cockatiel";
import { trackEvent } from "./app-insights";
import {
	BreakerStateValue,
	providerBreakerState,
	providerRequestTotal,
} from "./app-metrics";
import { getRegistration } from "./integration-registry";

// -----------------------------------------------------------------------------
// Module-scoped breaker cache
// -----------------------------------------------------------------------------

/**
 * One breaker per provider key. Lazily created on first lookup and
 * never evicted — process lifetime caching is correct here since the
 * registry is static.
 */
const BREAKERS = new Map<string, CircuitBreakerPolicy>();

/** Breaker defaults. */
const DEFAULT_CONSECUTIVE_THRESHOLD = 5;

/**
 * How long a tripped breaker stays open before admitting one probe.
 *
 * Exported because it is part of the breaker's contract to callers, not just an
 * internal tuning knob: any caller that retries a call made through
 * `withProviderBreaker` has to outlast this window, or its retries are
 * guaranteed no-ops that never reach the provider. `@repo/temporal`'s
 * reviewer-email retry policy asserts against it.
 */
export const DEFAULT_HALF_OPEN_AFTER_MS = 30_000;

// -----------------------------------------------------------------------------
// isRateLimit — permissive 429 / rate-limit predicate
// -----------------------------------------------------------------------------

/**
 * Return `true` when the value looks like a provider rate-limit error.
 *
 * Covers the common patterns we see across SDKs:
 *
 * - HTTP status 429 surfaced as `status`, `statusCode`, or
 *   `$metadata.httpStatusCode` (AWS SDK v3).
 * - Cockatiel errors are deliberately NOT rate-limit — `circuit_open`
 *   has its own bucket.
 * - SDK-specific names (`RateLimitError`, `ThrottlingException`) — best
 *   effort match against the class name.
 *
 * Permissive on purpose: we'd rather over-classify a few transient 429s
 * than miss them. Operators looking at `outcome="rate_limited"` should
 * see a roughly correct count, not a leak-proof guarantee.
 */
export function isRateLimit(err: unknown): boolean {
	if (err === null || err === undefined) {
		return false;
	}
	if (typeof err !== "object") {
		return false;
	}

	const candidate = err as {
		status?: number;
		statusCode?: number;
		code?: string | number;
		name?: string;
		$metadata?: { httpStatusCode?: number };
	};

	if (candidate.status === 429) {
		return true;
	}
	if (candidate.statusCode === 429) {
		return true;
	}
	if (candidate.$metadata?.httpStatusCode === 429) {
		return true;
	}
	if (candidate.code === 429 || candidate.code === "429") {
		return true;
	}

	const name = candidate.name?.toLowerCase() ?? "";
	if (
		name === "ratelimiterror" ||
		name === "rate_limit_error" ||
		name === "throttlingexception" ||
		name === "toomanyrequestsexception"
	) {
		return true;
	}

	return false;
}

// -----------------------------------------------------------------------------
// getBreaker — lazy, cached factory
// -----------------------------------------------------------------------------

/**
 * Resolve (or create) the `CircuitBreakerPolicy` for a given provider
 * key. The breaker is configured with 5 consecutive failures → open,
 * 30s half-open trial. State changes are mirrored to the
 * `provider_breaker_state` gauge.
 *
 * Throws when the provider key is not registered with a `breakerKey` —
 * that's a programming error: only MVP-5 providers have breakers.
 */
export function getBreaker(providerKey: string): CircuitBreakerPolicy {
	const cached = BREAKERS.get(providerKey);
	if (cached) {
		return cached;
	}

	const reg = getRegistration(providerKey);
	if (!reg?.breakerKey) {
		throw new Error(
			`No breaker configured for provider "${providerKey}". ` +
				"Only MVP-5 providers (openai, anthropic, stripe, resend, aws_s3) have breakers.",
		);
	}
	const breakerKey = reg.breakerKey;

	const breaker = circuitBreaker(handleAll, {
		halfOpenAfter: DEFAULT_HALF_OPEN_AFTER_MS,
		breaker: new ConsecutiveBreaker(DEFAULT_CONSECUTIVE_THRESHOLD),
	});

	// Initialize gauge to CLOSED so dashboards have a series from boot.
	providerBreakerState.set(
		{ provider: providerKey, breaker_key: breakerKey },
		BreakerStateValue.CLOSED,
	);

	breaker.onBreak(() => {
		providerBreakerState.set(
			{ provider: providerKey, breaker_key: breakerKey },
			BreakerStateValue.OPEN,
		);
		// App Insights — feeds the `CircuitBreakerOpened` KQL alert rule
		// in `deployment/azure/modules/monitoring.bicep` (runs every 1m
		// over the last 5m window, severity 0).
		trackEvent("CircuitBreakerStateChange", {
			provider: providerKey,
			breakerKey,
			newState: "open",
			oldState: "closed",
		});
		console.info(
			`[breaker] ${providerKey} (${breakerKey}) → OPEN — short-circuiting`,
		);
	});
	breaker.onHalfOpen(() => {
		providerBreakerState.set(
			{ provider: providerKey, breaker_key: breakerKey },
			BreakerStateValue.HALF_OPEN,
		);
		trackEvent("CircuitBreakerStateChange", {
			provider: providerKey,
			breakerKey,
			newState: "half-open",
			oldState: "open",
		});
		console.info(
			`[breaker] ${providerKey} (${breakerKey}) → HALF_OPEN — probing recovery`,
		);
	});
	breaker.onReset(() => {
		providerBreakerState.set(
			{ provider: providerKey, breaker_key: breakerKey },
			BreakerStateValue.CLOSED,
		);
		trackEvent("CircuitBreakerStateChange", {
			provider: providerKey,
			breakerKey,
			newState: "closed",
			oldState: "half-open",
		});
		console.info(
			`[breaker] ${providerKey} (${breakerKey}) → CLOSED — recovered`,
		);
	});

	BREAKERS.set(providerKey, breaker);
	return breaker;
}

// -----------------------------------------------------------------------------
// withProviderBreaker — outcome-recording call helper
// -----------------------------------------------------------------------------

/**
 * Outcome label values for `provider_request_total`. Re-exported for
 * call-site convenience; the upstream definition lives on
 * `ProviderOutcomeLabel` in `./app-metrics.ts`.
 */
export type WithProviderBreakerOutcome =
	| "success"
	| "error"
	| "rate_limited"
	| "circuit_open";

/**
 * Execute `fn` under the provider's circuit breaker, recording the
 * outcome on `provider_request_total{provider, operation, outcome}`.
 *
 * Outcomes:
 *
 * - `success`      — `fn` resolved.
 * - `circuit_open` — the breaker rejected the call BEFORE invoking `fn`
 *                    (Cockatiel throws `BrokenCircuitError` /
 *                    `IsolatedCircuitError`).
 * - `rate_limited` — `fn` threw and {@link isRateLimit} matched.
 * - `error`        — everything else.
 *
 * The error is always re-thrown so callers can apply their own retry
 * or fallback logic — this helper is observation-only on the failure
 * path.
 */
export async function withProviderBreaker<T>(
	providerKey: string,
	operation: string,
	fn: () => Promise<T>,
): Promise<T> {
	const breaker = getBreaker(providerKey);
	try {
		const result = await breaker.execute(() => fn());
		providerRequestTotal.inc({
			provider: providerKey,
			operation,
			outcome: "success",
		});
		return result;
	} catch (error) {
		const outcome = classifyOutcome(error);
		providerRequestTotal.inc({
			provider: providerKey,
			operation,
			outcome,
		});
		throw error;
	}
}

function classifyOutcome(error: unknown): WithProviderBreakerOutcome {
	if (isBrokenCircuitError(error) || isIsolatedCircuitError(error)) {
		return "circuit_open";
	}
	if (isRateLimit(error)) {
		return "rate_limited";
	}
	return "error";
}

// -----------------------------------------------------------------------------
// Test-only hooks
// -----------------------------------------------------------------------------

/**
 * Drop every cached breaker. Tests that need a clean slate (or want to
 * exercise the lazy-creation path more than once) call this in
 * `beforeEach`. Not part of the public API surface — guarded by the
 * leading `__` so it shows up at the bottom of IntelliSense and never
 * accidentally winds up in production call sites.
 */
export function __resetBreakersForTests(): void {
	BREAKERS.clear();
}
