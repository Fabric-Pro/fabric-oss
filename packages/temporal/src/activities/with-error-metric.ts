/**
 * Activity error-metric wrapper.
 *
 * Wraps a Temporal activity body so that, when the activity throws AND
 * is on its final retry attempt, `app_errors_total` is incremented exactly
 * once with the bounded label set:
 *
 *   { service: "temporal-worker", feature: "temporal_activity",
 *     error_class: "activity_failure", organization_id }
 *
 * The wrapper also increments `http_requests_total` exactly once per
 * activity attempt — succeeding or final-failing — so the burn-rate
 * denominator (`app_errors_total / http_requests_total`) is meaningful for
 * the `(temporal-worker, temporal_activity)` series. Activities count as
 * "requests" in our SLO model: each retry attempt is one unit of work,
 * and the rate of failed final attempts versus all attempts is the
 * SLO-relevant ratio.
 *
 * The wrapper respects Temporal's retry policy: it only increments
 * `app_errors_total` on the LAST attempt of the configured retry policy.
 * This avoids double-counting retries as separate errors. Temporal exposes
 * the current attempt count via `activityInfo()` and a "max attempts" via
 * the workflow's retry policy (defaulted to 5 when unspecified — the
 * activity itself can't read the workflow's policy, so we use a
 * conservative cap heuristic of `info.attempt >= 5`).
 *
 * Activities OPT IN by wrapping their body:
 *
 * ```ts
 * export async function uploadAttachment(input: Input) {
 *   return withErrorMetric(
 *     { feature: "temporal_activity", organizationId: input.organizationId },
 *     async () => {
 *       // ...actual work...
 *     }
 *   );
 * }
 * ```
 *
 * The wrapper is opt-in (not a global interceptor) because activities have
 * varied input shapes and the `organizationId` extraction must be explicit
 * to preserve tenant-isolation guarantees.
 */

import {
	appErrorsTotal,
	classifyError,
	type FeatureLabel,
	httpRequestsTotal,
	organizationLabel,
	trackMetric,
} from "@repo/observability";
import { activityInfo } from "@temporalio/activity";

export interface WithErrorMetricOptions {
	/**
	 * Which `feature` label the metric should use. Defaults to
	 * "temporal_activity" — the catch-all for any activity. Specific
	 * activities can pass a narrower feature (e.g., "document_processing"
	 * for the doc-processing pipeline activities).
	 */
	feature?: FeatureLabel;
	/**
	 * Organization ID for the operation. Pass the activity input's
	 * organizationId — `null` / `undefined` / `""` all collapse to the
	 * "personal" tenant label.
	 */
	organizationId?: string | null | undefined;
	/**
	 * Maximum retry-attempt count to use when deciding whether the current
	 * call is the final attempt. Defaults to 5 (Temporal's default retry
	 * policy). Set this to match your activity's configured `maximumAttempts`
	 * so the metric increments exactly once per workflow execution.
	 */
	maxAttempts?: number;
}

/**
 * Resolve the running Temporal activity's attempt number. Returns 1
 * when called outside an activity context (test / unit path).
 */
function currentAttempt(): number {
	try {
		return activityInfo().attempt;
	} catch {
		return 1;
	}
}

/**
 * Resolve the running activity's name. Used as the `route` label on
 * `http_requests_total` so each activity contributes its own series —
 * cardinality is bounded by the number of distinct activity functions
 * registered on the worker (~50 in v1).
 *
 * Falls back to "unknown" outside an activity context so the metric
 * still emits in unit tests.
 */
function currentActivityType(): string {
	try {
		return activityInfo().activityType;
	} catch {
		return "unknown";
	}
}

/**
 * Resolve the activity's retry policy's maximum attempts. The activity
 * runtime DOES expose `info.attempt` but not `info.maximumAttempts`, so
 * callers must pass it through `options.maxAttempts` for accuracy.
 *
 * Temporal's default when unspecified is "infinite retries" (best-effort).
 * Conservative default 5 matches the de-facto policy used across the
 * fabric activities and limits over-counting if a caller forgets to set.
 */
function resolveMaxAttempts(options: WithErrorMetricOptions): number {
	return Math.max(1, options.maxAttempts ?? 5);
}

/**
 * Wrap an activity body. If the activity succeeds, the `httpRequestsTotal`
 * counter is incremented with `status_class: "2xx"`. If the activity
 * throws, `httpRequestsTotal` is incremented with `status_class: "5xx"`
 * and `appErrorsTotal` is also incremented IFF we are on the final retry
 * attempt. The original error is always re-thrown so Temporal sees the
 * failure unchanged.
 *
 * Both counters share the same `(service, feature)` tuple so the
 * burn-rate ratio `app_errors_total / http_requests_total` resolves
 * cleanly per service/feature/route in Prometheus.
 */
export async function withErrorMetric<T>(
	options: WithErrorMetricOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const feature = options.feature ?? "temporal_activity";
	const route = currentActivityType();
	const organization_id = organizationLabel(options.organizationId);
	try {
		const result = await fn();
		// Success: count the attempt as a 2xx "request" so the
		// burn-rate denominator is non-zero on healthy traffic.
		try {
			httpRequestsTotal.inc({
				service: "temporal-worker",
				feature,
				method: "TEMPORAL",
				route,
				status_class: "2xx",
			});
			trackMetric("HttpRequest", 1, {
				service: "temporal-worker",
				feature,
				method: "TEMPORAL",
				route,
				statusClass: "2xx",
			});
		} catch {
			// Never let metric emission crash the activity happy path.
		}
		return result;
	} catch (error) {
		try {
			const attempt = currentAttempt();
			const maxAttempts = resolveMaxAttempts(options);

			// Count the attempt in the denominator regardless of retry
			// state — every attempt is one unit of work and the
			// burn-rate math expects "requests" to include all attempts.
			// The numerator (`app_errors_total`) is gated by
			// final-attempt to avoid double-counting retries as separate
			// SLO breaches.
			httpRequestsTotal.inc({
				service: "temporal-worker",
				feature,
				method: "TEMPORAL",
				route,
				status_class: "5xx",
			});
			trackMetric("HttpRequest", 1, {
				service: "temporal-worker",
				feature,
				method: "TEMPORAL",
				route,
				statusClass: "5xx",
			});

			// Only emit on the final attempt — avoids double-counting
			// transient retried failures.
			if (attempt >= maxAttempts) {
				const classified = classifyError(error);
				const finalErrorClass =
					classified === "unhandled" || classified === "unknown"
						? "activity_failure"
						: classified;
				appErrorsTotal.inc({
					service: "temporal-worker",
					feature,
					// Activities map to a fixed coarse class — the
					// "activity_failure" label is reserved for this path.
					// We still consult classifyError() for downstream-4xx
					// vs timeout vs 5xx in case the activity threw something
					// the classifier handles.
					error_class: finalErrorClass,
					organization_id,
				});
				trackMetric("AppError", 1, {
					service: "temporal-worker",
					feature,
					errorClass: finalErrorClass,
					organizationId: organization_id,
				});
			}
		} catch {
			// Never let metric emission crash the activity error path.
		}
		throw error;
	}
}
