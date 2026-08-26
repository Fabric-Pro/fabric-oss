/**
 * Tests for the Temporal activity error-metric wrapper.
 *
 * Tests run outside an active Temporal activity context — `activityInfo()`
 * throws, and the wrapper falls back to `attempt = 1`. We exercise both
 * the "single attempt = always emit" path and the "max-attempts gating"
 * path by overriding `maxAttempts` to 1.
 */

import {
	appErrorsTotal,
	httpRequestsTotal,
	register,
} from "@repo/observability";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorMetric } from "../with-error-metric";

beforeEach(() => {
	appErrorsTotal.reset();
	httpRequestsTotal.reset();
});

describe("withErrorMetric", () => {
	it("passes through the value on success and does not touch app_errors_total", async () => {
		const result = await withErrorMetric(
			{ organizationId: "org_abc", maxAttempts: 1 },
			async () => 42,
		);
		expect(result).toBe(42);

		const text = await register.metrics();
		expect(text).not.toMatch(
			/app_errors_total\{[^}]*service="temporal-worker"[^}]*\} \d/,
		);
	});

	it("increments http_requests_total with 2xx on success — burn-rate denominator", async () => {
		const result = await withErrorMetric(
			{ organizationId: "org_abc", maxAttempts: 1 },
			async () => 42,
		);
		expect(result).toBe(42);

		const text = await register.metrics();
		expect(text).toContain("http_requests_total");
		expect(text).toContain('service="temporal-worker"');
		expect(text).toContain('feature="temporal_activity"');
		expect(text).toContain('method="TEMPORAL"');
		expect(text).toContain('status_class="2xx"');
	});

	it("increments http_requests_total with 5xx on failure — burn-rate denominator", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: "org_abc", maxAttempts: 1 },
				async () => {
					throw new Error("activity bork");
				},
			),
		).rejects.toThrow("activity bork");

		const text = await register.metrics();
		expect(text).toContain("http_requests_total");
		expect(text).toContain('status_class="5xx"');
	});

	it("increments app_errors_total with the temporal-worker label set on the final attempt", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: "org_abc", maxAttempts: 1 },
				async () => {
					throw new Error("activity bork");
				},
			),
		).rejects.toThrow("activity bork");

		const text = await register.metrics();
		expect(text).toContain('service="temporal-worker"');
		expect(text).toContain('feature="temporal_activity"');
		expect(text).toContain('error_class="activity_failure"');
		expect(text).toContain('organization_id="org_abc"');
	});

	it("emits 'personal' for organization_id when none is provided", async () => {
		await expect(
			withErrorMetric({ maxAttempts: 1 }, async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow();

		const text = await register.metrics();
		expect(text).toContain('organization_id="personal"');
	});

	it("emits 'personal' for explicit null organizationId", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: null, maxAttempts: 1 },
				async () => {
					throw new Error("nope");
				},
			),
		).rejects.toThrow();

		const text = await register.metrics();
		expect(text).toContain('organization_id="personal"');
	});

	it("uses caller-supplied feature label when set", async () => {
		await expect(
			withErrorMetric(
				{
					organizationId: "org_x",
					feature: "document_processing",
					maxAttempts: 1,
				},
				async () => {
					throw new Error("doc bork");
				},
			),
		).rejects.toThrow();

		const text = await register.metrics();
		expect(text).toContain('feature="document_processing"');
	});

	it("re-throws the original error unchanged", async () => {
		const err = new Error("specific");
		await expect(
			withErrorMetric({ maxAttempts: 1 }, async () => {
				throw err;
			}),
		).rejects.toBe(err);
	});

	it("never emits user_id as a label (cardinality guard)", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: "org_x", maxAttempts: 1 },
				async () => {
					throw new Error("err");
				},
			),
		).rejects.toThrow();

		const text = await register.metrics();
		expect(text).not.toContain("user_id=");
		expect(text).not.toContain("userId=");
	});

	it("classifies a thrown timeout error as error_class='timeout' (overrides default)", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: "org_x", maxAttempts: 1 },
				async () => {
					const err = new Error("upstream timed out");
					err.name = "TimeoutError";
					throw err;
				},
			),
		).rejects.toThrow();

		const text = await register.metrics();
		expect(text).toContain('error_class="timeout"');
	});

	it("does NOT increment when attempt is below maxAttempts", async () => {
		// Outside an activity, `currentAttempt()` returns 1. By passing
		// maxAttempts=5, the wrapper should NOT emit the metric — this
		// proves we honor the retry-gate even on failures.
		await expect(
			withErrorMetric(
				{ organizationId: "org_x", maxAttempts: 5 },
				async () => {
					throw new Error("transient");
				},
			),
		).rejects.toThrow("transient");

		const text = await register.metrics();
		expect(text).not.toMatch(
			/app_errors_total\{[^}]*service="temporal-worker"[^}]*\} \d/,
		);
	});

	it("increments exactly once per call on the final attempt", async () => {
		await expect(
			withErrorMetric(
				{ organizationId: "org_x", maxAttempts: 1 },
				async () => {
					throw new Error("boom");
				},
			),
		).rejects.toThrow();

		const text = await register.metrics();
		const match = text.match(
			/app_errors_total\{[^}]*service="temporal-worker"[^}]*\} (\d+)/,
		);
		expect(match).toBeTruthy();
		expect(Number(match![1])).toBe(1);
	});
});
