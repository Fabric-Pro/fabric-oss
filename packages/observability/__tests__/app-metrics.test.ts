/**
 * Application Error-Rate + Integration Metrics
 *
 * Verifies the metric names, labels, and helpers defined in
 * `packages/observability/lib/app-metrics.ts`.
 *
 * Tests use the REAL shared `register` (no mocks). Metrics are reset
 * between tests so counters start from zero.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	appErrorsTotal,
	BreakerStateValue,
	httpRequestsTotal,
	organizationLabel,
	PERSONAL_ORG_LABEL,
	providerBreakerState,
	providerRequestTotal,
	statusCodeToClass,
	syntheticProbeDuration,
	syntheticProbeResult,
} from "../lib/app-metrics";
import { register } from "../lib/metrics";

beforeEach(() => {
	appErrorsTotal.reset();
	providerRequestTotal.reset();
	providerBreakerState.reset();
	syntheticProbeResult.reset();
	syntheticProbeDuration.reset();
	httpRequestsTotal.reset();
});

describe("appErrorsTotal", () => {
	it("uses the exact canonical metric name", () => {
		expect((appErrorsTotal as unknown as { name: string }).name).toBe(
			"app_errors_total",
		);
	});

	it("increments with the full label set", async () => {
		appErrorsTotal.inc({
			service: "api",
			feature: "ai_generation",
			error_class: "5xx",
			organization_id: "org_abc123",
		});

		const exposition = await register.metrics();
		expect(exposition).toContain("app_errors_total{");
		expect(exposition).toContain('service="api"');
		expect(exposition).toContain('feature="ai_generation"');
		expect(exposition).toContain('error_class="5xx"');
		expect(exposition).toContain('organization_id="org_abc123"');
	});

	it("emits the literal string 'personal' for personal-tenant context", async () => {
		appErrorsTotal.inc({
			service: "api",
			feature: "auth",
			error_class: "unhandled",
			organization_id: PERSONAL_ORG_LABEL,
		});

		const exposition = await register.metrics();
		expect(exposition).toContain('organization_id="personal"');
	});

	it("does not register a user_id label (cardinality guard)", () => {
		// prom-client enforces label names at definition time. Trying to
		// pass `user_id` raises before instrumentation can leak userId.
		expect(() => {
			(
				appErrorsTotal as unknown as {
					inc: (labels: Record<string, string>) => void;
				}
			).inc({
				service: "api",
				feature: "ai_generation",
				error_class: "5xx",
				organization_id: "org_x",
				user_id: "user_should_never_be_label",
			});
		}).toThrow();
	});
});

describe("providerRequestTotal", () => {
	it("uses the exact canonical metric name", () => {
		expect((providerRequestTotal as unknown as { name: string }).name).toBe(
			"provider_request_total",
		);
	});

	it("supports all four outcome label values", async () => {
		for (const outcome of [
			"success",
			"error",
			"rate_limited",
			"circuit_open",
		] as const) {
			providerRequestTotal.inc({
				provider: "openai",
				operation: "chat_completion",
				outcome,
			});
		}

		const exposition = await register.metrics();
		expect(exposition).toContain('outcome="success"');
		expect(exposition).toContain('outcome="error"');
		expect(exposition).toContain('outcome="rate_limited"');
		expect(exposition).toContain('outcome="circuit_open"');
	});
});

describe("providerBreakerState", () => {
	it("uses the exact canonical metric name", () => {
		expect((providerBreakerState as unknown as { name: string }).name).toBe(
			"provider_breaker_state",
		);
	});

	it("emits numeric values matching BreakerStateValue", async () => {
		providerBreakerState.set(
			{ provider: "openai", breaker_key: "openai_chat" },
			BreakerStateValue.OPEN,
		);
		providerBreakerState.set(
			{ provider: "stripe", breaker_key: "stripe_payments" },
			BreakerStateValue.HALF_OPEN,
		);

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="openai"[^}]*\}\s+2/,
		);
		expect(exposition).toMatch(
			/provider_breaker_state\{[^}]*provider="stripe"[^}]*\}\s+1/,
		);
	});

	it("encodes BreakerStateValue as 0=closed / 1=half_open / 2=open", () => {
		expect(BreakerStateValue.CLOSED).toBe(0);
		expect(BreakerStateValue.HALF_OPEN).toBe(1);
		expect(BreakerStateValue.OPEN).toBe(2);
	});
});

describe("syntheticProbeResult", () => {
	it("uses the exact canonical metric name", () => {
		expect((syntheticProbeResult as unknown as { name: string }).name).toBe(
			"synthetic_probe_result_total",
		);
	});

	it("supports the three probe outcomes", async () => {
		for (const outcome of ["success", "failure", "timeout"] as const) {
			syntheticProbeResult.inc({ provider: "stripe", outcome });
		}
		const exposition = await register.metrics();
		// prom-client renders labels alphabetically; check both labels are present.
		expect(exposition).toContain("synthetic_probe_result_total");
		expect(exposition).toContain('provider="stripe"');
		expect(exposition).toContain('outcome="success"');
		expect(exposition).toContain('outcome="failure"');
		expect(exposition).toContain('outcome="timeout"');
	});
});

describe("syntheticProbeDuration", () => {
	it("uses the exact canonical metric name", () => {
		expect(
			(syntheticProbeDuration as unknown as { name: string }).name,
		).toBe("synthetic_probe_duration_seconds");
	});

	it("records observations into the histogram buckets", async () => {
		syntheticProbeDuration.observe({ provider: "openai" }, 0.42);
		syntheticProbeDuration.observe({ provider: "openai" }, 3.1);

		const exposition = await register.metrics();
		expect(exposition).toContain("synthetic_probe_duration_seconds_bucket");
		expect(exposition).toContain('provider="openai"');
	});
});

describe("organizationLabel", () => {
	it("returns 'personal' for null/undefined input", () => {
		expect(organizationLabel(null)).toBe("personal");
		expect(organizationLabel(undefined)).toBe("personal");
	});

	it("returns the cuid string for org context", () => {
		expect(organizationLabel("org_abc123")).toBe("org_abc123");
	});

	it("never returns empty string", () => {
		// Note: empty string is technically truthy-falsey ("" is falsy), so
		// the helper preserves it as-is. This is a guard test to surface if
		// the contract ever changes.
		expect(organizationLabel("")).toBe("personal");
	});
});

describe("httpRequestsTotal", () => {
	it("uses the exact canonical metric name", () => {
		expect((httpRequestsTotal as unknown as { name: string }).name).toBe(
			"http_requests_total",
		);
	});

	it("increments with the full label set", async () => {
		httpRequestsTotal.inc({
			service: "api",
			feature: "ai_generation",
			method: "POST",
			route: "ai.generateTitle",
			status_class: "2xx",
		});

		const exposition = await register.metrics();
		expect(exposition).toContain("http_requests_total{");
		expect(exposition).toContain('service="api"');
		expect(exposition).toContain('feature="ai_generation"');
		expect(exposition).toContain('method="POST"');
		expect(exposition).toContain('route="ai.generateTitle"');
		expect(exposition).toContain('status_class="2xx"');
	});

	it("supports the four status_class buckets", async () => {
		for (const status_class of ["2xx", "3xx", "4xx", "5xx"] as const) {
			httpRequestsTotal.inc({
				service: "api",
				feature: "ai_generation",
				method: "POST",
				route: "ai.x",
				status_class,
			});
		}
		const exposition = await register.metrics();
		expect(exposition).toContain('status_class="2xx"');
		expect(exposition).toContain('status_class="3xx"');
		expect(exposition).toContain('status_class="4xx"');
		expect(exposition).toContain('status_class="5xx"');
	});

	it("does not register a userId or raw-status-code label (cardinality guard)", () => {
		expect(() => {
			(
				httpRequestsTotal as unknown as {
					inc: (labels: Record<string, string>) => void;
				}
			).inc({
				service: "api",
				feature: "ai_generation",
				method: "POST",
				route: "ai.x",
				status_class: "2xx",
				status_code: "503", // not in labelNames
			});
		}).toThrow();
	});
});

describe("statusCodeToClass", () => {
	it("maps 2xx codes to '2xx'", () => {
		expect(statusCodeToClass(200)).toBe("2xx");
		expect(statusCodeToClass(204)).toBe("2xx");
		expect(statusCodeToClass(299)).toBe("2xx");
	});

	it("maps 3xx codes to '3xx'", () => {
		expect(statusCodeToClass(301)).toBe("3xx");
		expect(statusCodeToClass(304)).toBe("3xx");
	});

	it("maps 4xx codes to '4xx'", () => {
		expect(statusCodeToClass(400)).toBe("4xx");
		expect(statusCodeToClass(404)).toBe("4xx");
		expect(statusCodeToClass(429)).toBe("4xx");
	});

	it("maps 5xx codes to '5xx'", () => {
		expect(statusCodeToClass(500)).toBe("5xx");
		expect(statusCodeToClass(503)).toBe("5xx");
	});

	it("returns '5xx' for non-HTTP-range numbers", () => {
		expect(statusCodeToClass(0)).toBe("5xx");
		expect(statusCodeToClass(-1)).toBe("5xx");
		expect(statusCodeToClass(999)).toBe("5xx");
	});
});

describe("register integration", () => {
	it("exposes all six canonical metrics on the shared registry", async () => {
		// Touch every metric once to ensure they materialize on the registry.
		appErrorsTotal.inc({
			service: "api",
			feature: "ai_generation",
			error_class: "5xx",
			organization_id: "personal",
		});
		providerRequestTotal.inc({
			provider: "openai",
			operation: "chat_completion",
			outcome: "success",
		});
		providerBreakerState.set(
			{ provider: "openai", breaker_key: "openai_chat" },
			0,
		);
		syntheticProbeResult.inc({ provider: "openai", outcome: "success" });
		syntheticProbeDuration.observe({ provider: "openai" }, 0.1);
		httpRequestsTotal.inc({
			service: "api",
			feature: "ai_generation",
			method: "POST",
			route: "ai.x",
			status_class: "2xx",
		});

		const exposition = await register.metrics();

		expect(exposition).toMatch(/# HELP app_errors_total/);
		expect(exposition).toMatch(/# HELP provider_request_total/);
		expect(exposition).toMatch(/# HELP provider_breaker_state/);
		expect(exposition).toMatch(/# HELP synthetic_probe_result_total/);
		expect(exposition).toMatch(/# HELP synthetic_probe_duration_seconds/);
		expect(exposition).toMatch(/# HELP http_requests_total/);
	});
});
