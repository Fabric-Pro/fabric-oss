/**
 * Cockatiel breaker integration — unit tests
 *
 * Verifies the `getBreaker` / `withProviderBreaker` helpers against the
 * REAL prom-client registry (no metric mocks).
 *
 * The tests use vitest's fake timers because Cockatiel transitions
 * from OPEN → HALF_OPEN after a real wall-clock delay (30s).
 * Faking time lets the breaker state-machine progress deterministically
 * without sleeping.
 *
 * Live registry note: the breakers module reads `breakerKey` from the
 * integration registry. The live registry is loaded for side effects
 * by `integration-providers.ts` at test boot (we import it
 * implicitly via the test setup chain). For provider keys outside
 * MVP-5 we register a synthetic test entry inside the relevant
 * `describe` so the unhappy paths are exercised in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerBreakerState, providerRequestTotal } from "../lib/app-metrics";
import {
	__resetBreakersForTests,
	getBreaker,
	isRateLimit,
	withProviderBreaker,
} from "../lib/breakers";
// Side-effect import — populates the live registry so `getBreaker("openai")`
// can resolve a `breakerKey`. Must run before tests that read it.
import "../lib/integration-providers";
import {
	__resetRegistryForTests,
	listRegistrations,
	registerIntegrationProvider,
} from "../lib/integration-registry";
import { register } from "../lib/metrics";

/**
 * Snapshot the live registry at file-load time so we can restore it
 * after suites that exercise the unhappy paths via synthetic provider
 * registrations.
 */
const LIVE_SNAPSHOT = listRegistrations();

function restoreLiveRegistry(): void {
	__resetRegistryForTests();
	for (const reg of LIVE_SNAPSHOT) {
		registerIntegrationProvider(reg);
	}
}

function resetMetrics(): void {
	providerRequestTotal.reset();
	providerBreakerState.reset();
}

beforeEach(() => {
	resetMetrics();
	__resetBreakersForTests();
});

afterEach(() => {
	restoreLiveRegistry();
	vi.useRealTimers();
});

// =============================================================================
// isRateLimit predicate
// =============================================================================

describe("isRateLimit", () => {
	it("matches HTTP 429 on `status`", () => {
		expect(isRateLimit({ status: 429 })).toBe(true);
	});

	it("matches HTTP 429 on `statusCode`", () => {
		expect(isRateLimit({ statusCode: 429 })).toBe(true);
	});

	it("matches AWS SDK v3 `$metadata.httpStatusCode === 429`", () => {
		expect(isRateLimit({ $metadata: { httpStatusCode: 429 } })).toBe(true);
	});

	it("matches the numeric `code` form", () => {
		expect(isRateLimit({ code: 429 })).toBe(true);
		expect(isRateLimit({ code: "429" })).toBe(true);
	});

	it("matches SDK-specific names regardless of case", () => {
		expect(isRateLimit({ name: "RateLimitError" })).toBe(true);
		expect(isRateLimit({ name: "ThrottlingException" })).toBe(true);
		expect(isRateLimit({ name: "TooManyRequestsException" })).toBe(true);
	});

	it("returns false for non-rate-limit errors", () => {
		expect(isRateLimit({ status: 500 })).toBe(false);
		expect(isRateLimit({ name: "ValidationError" })).toBe(false);
		expect(isRateLimit(new Error("boom"))).toBe(false);
	});

	it("returns false for non-objects", () => {
		expect(isRateLimit(undefined)).toBe(false);
		expect(isRateLimit(null)).toBe(false);
		expect(isRateLimit("429")).toBe(false);
		expect(isRateLimit(429)).toBe(false);
	});
});

// =============================================================================
// getBreaker — caching & registry coupling
// =============================================================================

describe("getBreaker", () => {
	it("returns a breaker for a registered MVP-5 provider", () => {
		const breaker = getBreaker("openai");
		expect(breaker).toBeDefined();
		expect(typeof breaker.execute).toBe("function");
	});

	it("returns the SAME breaker instance on repeat calls (caching)", () => {
		const a = getBreaker("openai");
		const b = getBreaker("openai");
		expect(a).toBe(b);
	});

	it("throws for a provider without a breakerKey", () => {
		// DataConnectionProvider entries (e.g., "github") have no
		// `breakerKey` configured.
		expect(() => getBreaker("github")).toThrow(/no breaker configured/i);
	});

	it("throws for an unregistered provider", () => {
		expect(() => getBreaker("does_not_exist")).toThrow(
			/no breaker configured/i,
		);
	});

	it("initializes the gauge to CLOSED on first construction", async () => {
		getBreaker("openai");
		const exposition = await register.metrics();
		// gauge series for openai/openai_completions should be at 0.
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="openai"[^}]*\}\s+0/,
		);
	});
});

// =============================================================================
// withProviderBreaker — outcome label coverage
// =============================================================================

describe("withProviderBreaker — outcome labels", () => {
	it("records `success` when fn resolves", async () => {
		const result = await withProviderBreaker(
			"openai",
			"test_op",
			async () => "ok",
		);
		expect(result).toBe("ok");

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_request_total\{[^}]*outcome="success"[^}]*\}\s+1/,
		);
	});

	it("records `error` for a generic thrown error", async () => {
		await expect(
			withProviderBreaker("openai", "test_op", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_request_total\{[^}]*operation="test_op"[^}]*outcome="error"[^}]*\}\s+1/,
		);
	});

	it("records `rate_limited` when isRateLimit matches", async () => {
		await expect(
			withProviderBreaker("openai", "test_op", async () => {
				throw { status: 429, message: "Too many requests" };
			}),
		).rejects.toBeTruthy();

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_request_total\{[^}]*outcome="rate_limited"[^}]*\}\s+1/,
		);
	});

	it("records `circuit_open` when the breaker rejects the call", async () => {
		// Trip the breaker with 5 consecutive errors.
		for (let i = 0; i < 5; i++) {
			await expect(
				withProviderBreaker("openai", "trip_op", async () => {
					throw new Error("downstream failure");
				}),
			).rejects.toBeTruthy();
		}

		// Reset metric counters so we can isolate the next call's
		// outcome label.
		providerRequestTotal.reset();

		// The 6th call should be short-circuited.
		await expect(
			withProviderBreaker(
				"openai",
				"trip_op",
				async () => "should not run",
			),
		).rejects.toBeTruthy();

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_request_total\{[^}]*outcome="circuit_open"[^}]*\}\s+1/,
		);
	});

	it("includes the provider + operation labels on every increment", async () => {
		await withProviderBreaker(
			"openai",
			"chat_completion",
			async () => "ok",
		);
		const exposition = await register.metrics();
		expect(exposition).toContain('provider="openai"');
		expect(exposition).toContain('operation="chat_completion"');
	});
});

// =============================================================================
// withProviderBreaker — breaker state-machine transitions
// =============================================================================

describe("withProviderBreaker — state-machine transitions", () => {
	it("trips after 5 consecutive failures and sets the gauge to OPEN (2)", async () => {
		for (let i = 0; i < 5; i++) {
			await expect(
				withProviderBreaker("anthropic", "trip", async () => {
					throw new Error("fail");
				}),
			).rejects.toBeTruthy();
		}

		const exposition = await register.metrics();
		// Anthropic's breaker_key from the live registry is
		// `anthropic_messages`. Match loosely on the provider label.
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="anthropic"[^}]*\}\s+2/,
		);
	});

	it("transitions OPEN → HALF_OPEN after 30s and back to CLOSED on success", async () => {
		vi.useFakeTimers();

		// Step 1 — trip the breaker.
		for (let i = 0; i < 5; i++) {
			await expect(
				withProviderBreaker("stripe", "trip", async () => {
					throw new Error("downstream 500");
				}),
			).rejects.toBeTruthy();
		}

		let exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="stripe"[^}]*\}\s+2/,
		);

		// Step 2 — advance fake time past the 30s open duration. The
		// breaker enters HALF_OPEN on the NEXT execute() call.
		await vi.advanceTimersByTimeAsync(30_001);

		// Step 3 — issue the recovery call. The breaker enters
		// HALF_OPEN and a successful resolution closes it.
		await expect(
			withProviderBreaker("stripe", "trip", async () => "ok"),
		).resolves.toBe("ok");

		exposition = await register.metrics();
		// Gauge should now read CLOSED (0) for the stripe breaker.
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="stripe"[^}]*\}\s+0/,
		);
	});
});
