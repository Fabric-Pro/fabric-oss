/**
 * Request-counter middleware.
 *
 * Increments `http_requests_total` once per oRPC procedure invocation —
 * success or failure. The metric is the denominator for the burn-rate
 * error ratios in `deployment/prometheus/rules/app-errors.yml`; without
 * it the alerts evaluate to NaN and never fire.
 *
 * Label policy (every value enumerable + bounded):
 *   - service       = "api"  (oRPC procedures always run in the Hono API)
 *   - feature       = mapped via the same `deriveFeatureFromPath` helper
 *                     the error-metrics middleware uses, so the
 *                     numerator (`app_errors_total`) and denominator
 *                     (`http_requests_total`) always share the same
 *                     feature label and the burn-rate ratio works.
 *   - method        = HTTP verb. Captured from `context.headers`, falls
 *                     back to "POST" — oRPC is POST-by-default. We do NOT
 *                     accept arbitrary methods here: the value is
 *                     restricted to a small enum so unknown verbs collapse
 *                     to "OTHER".
 *   - route         = the joined oRPC `path` (e.g. "incidents.list").
 *                     This is a TEMPLATE — oRPC paths are static slug
 *                     tuples, NOT path-parameterized URLs, so cardinality
 *                     is bounded by the number of procedures (~200).
 *   - status_class  = derived from the thrown error (if any). Successful
 *                     handlers count as "2xx". oRPC errors with a numeric
 *                     `status` field use that; anything else collapses to
 *                     "5xx". See {@link statusCodeFromOrpcError}.
 *
 * The middleware must run BEFORE the error-metrics middleware so that
 * even procedures throwing UNAUTHORIZED at the auth step are counted.
 * The denominator must include the auth-rejected traffic — Prometheus's
 * "if request happened, count it" invariant is sacred for burn-rate math.
 */

import { os } from "@orpc/server";
import {
	type HttpStatusClassLabel,
	httpRequestsTotal,
	statusCodeToClass,
	trackMetric,
} from "@repo/observability";
import { deriveFeatureFromPath } from "./error-metrics-middleware";

const SERVICE = "api";

/** Allowed HTTP verbs. Anything else collapses to "OTHER". Cardinality: 6. */
export type HttpMethodLabel =
	| "GET"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE"
	| "OTHER";

const KNOWN_METHODS = new Set<HttpMethodLabel>([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
]);

/**
 * Normalize the incoming HTTP method into the bounded {@link HttpMethodLabel}
 * enum. Defaults to "POST" because oRPC uses POST for every procedure
 * invocation in the Hono adapter.
 */
export function normalizeMethod(method: string | undefined): HttpMethodLabel {
	if (!method) {
		return "POST";
	}
	const upper = method.toUpperCase();
	if (KNOWN_METHODS.has(upper as HttpMethodLabel)) {
		return upper as HttpMethodLabel;
	}
	return "OTHER";
}

/**
 * Best-effort status-code extraction from an oRPC error. oRPC's
 * `ORPCError` exposes a `status` property when set; many in-house
 * helpers attach `.status` directly. We do NOT throw if we can't
 * resolve a number — we return "5xx" so the request still lands in the
 * denominator.
 */
export function statusCodeFromOrpcError(error: unknown): HttpStatusClassLabel {
	if (error && typeof error === "object" && "status" in error) {
		const candidate = (error as { status?: unknown }).status;
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return statusCodeToClass(candidate);
		}
	}
	// oRPC `code` -> status mapping for the codes we observe. Everything
	// else collapses to 5xx — that is the SLO-correct default.
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		switch (code) {
			case "UNAUTHORIZED":
				return "4xx";
			case "FORBIDDEN":
				return "4xx";
			case "NOT_FOUND":
				return "4xx";
			case "BAD_REQUEST":
				return "4xx";
			case "TOO_MANY_REQUESTS":
				return "4xx";
			case "CONFLICT":
				return "4xx";
		}
	}
	return "5xx";
}

/**
 * Render an oRPC path tuple into a Prometheus route label. We join with
 * a `.` so admin tooling can split it back into segments if needed. The
 * empty path collapses to "(root)" rather than the empty string —
 * prom-client renders empty labels as `""` and that's a query footgun.
 */
export function renderRouteLabel(path: readonly string[]): string {
	if (path.length === 0) {
		return "(root)";
	}
	return path.join(".");
}

/**
 * Pure helper: increment the request counter with the given inputs.
 * Extracted so the middleware integration tests can verify the label
 * derivation without spinning up the oRPC framework. Never throws.
 */
export function recordRequest(input: {
	headers: Headers | undefined;
	path: readonly string[];
	error?: unknown;
}): void {
	try {
		const method = normalizeMethod(
			input.headers?.get?.("x-http-method") ?? undefined,
		);
		const feature = deriveFeatureFromPath(input.path);
		const route = renderRouteLabel(input.path);
		const status_class: HttpStatusClassLabel =
			input.error === undefined
				? "2xx"
				: statusCodeFromOrpcError(input.error);
		httpRequestsTotal.inc({
			service: SERVICE,
			feature,
			method,
			route,
			status_class,
		});
		// Mirror to App Insights so the burn-rate KQL alert rules (which
		// query `customMetrics` plus the auto-instrumented `requests`
		// table) have a per-feature view of request volume.
		trackMetric("HttpRequest", 1, {
			service: SERVICE,
			feature,
			method,
			route,
			statusClass: status_class,
		});
	} catch {
		// Never let the metric path crash a request.
	}
}

/**
 * Global oRPC request-counter middleware.
 *
 * Wraps `next()` in a try/catch: on success the counter increments with
 * `status_class: "2xx"`; on failure the counter increments with the
 * derived status class. The original error is re-thrown so downstream
 * middleware (auth, error-metrics, etc.) see the failure unchanged.
 *
 * Mount this BEFORE `errorMetricsMiddleware` on the root public
 * procedure so every request (auth-rejected or otherwise) is counted.
 */
export const requestCounterMiddleware = os
	.$context<{
		headers: Headers;
	}>()
	.middleware(async ({ context, next, path }) => {
		try {
			const result = await next();
			recordRequest({ headers: context.headers, path });
			return result;
		} catch (error) {
			recordRequest({ headers: context.headers, path, error });
			throw error;
		}
	});
