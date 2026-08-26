/**
 * Error Metrics Middleware
 *
 * Wraps every oRPC procedure invocation in a try/finally. When the handler
 * throws, we increment `app_errors_total` with the bounded label set:
 *   { service: "api", feature, error_class, organization_id }
 *
 * Label derivation rules:
 *   - `feature`        derived from the oRPC path's first segment (e.g.,
 *                      `ai.generateTitle` -> `ai_generation`). The mapping
 *                      table is intentionally small and review-gated.
 *   - `error_class`    derived from the thrown value via classifyError().
 *   - `organization_id` derived from session.activeOrganizationId. Personal
 *                      context emits the literal string "personal" — never
 *                      empty / null / undefined.
 *
 * The middleware is mounted globally so it observes every procedure,
 * including procedures that have not yet adopted tenantProtectedProcedure.
 */

import { os } from "@orpc/server";
import {
	appErrorsTotal,
	classifyError,
	type FeatureLabel,
	organizationLabel,
	trackMetric,
} from "@repo/observability";

const SERVICE = "api";

/**
 * Context shape consumed by {@link recordProcedureError}. The middleware
 * sees a wider context; we narrow to only the fields that influence the
 * recorded label values.
 */
export interface ErrorMetricsContext {
	session?: { activeOrganizationId?: string | null } | undefined;
	tenantContext?:
		| {
				type: "organization" | "personal";
				organizationId?: string | null;
		  }
		| undefined;
}

/**
 * Map an oRPC procedure path to the feature label it belongs to.
 *
 * Cardinality budget: the label set is closed (see FeatureLabel). Anything
 * that does not match a known prefix collapses to "auth" (which is the
 * safe catch-all in the 6-value enum — most unmapped procedures are auth /
 * settings flows).
 */
export function deriveFeatureFromPath(path: readonly string[]): FeatureLabel {
	const root = path[0] ?? "";

	// Ordered by likelihood of being on the hot path.
	if (
		root === "ai" ||
		root === "agents" ||
		root === "chats" ||
		root === "stories" ||
		root.includes("workflow") ||
		root.includes("generate")
	) {
		return "ai_generation";
	}
	if (
		root === "payments" ||
		root === "billing" ||
		root === "subscriptions" ||
		root === "checkout"
	) {
		return "payments";
	}
	if (
		root === "documents" ||
		root === "chatDocument" ||
		root === "rag" ||
		root.includes("document")
	) {
		return "document_processing";
	}
	if (
		root === "projects" ||
		root === "pm" ||
		root.includes("pmSync") ||
		root === "integrations"
	) {
		return "pm_sync";
	}
	return "auth";
}

/**
 * Pure error-recording function. Extracted from the oRPC middleware so it
 * is unit-testable without spinning up the oRPC framework. Increments the
 * `app_errors_total` counter exactly once with bounded labels.
 *
 * Safe to call from inside an error handler — never throws.
 */
export function recordProcedureError(
	error: unknown,
	context: ErrorMetricsContext,
	path: readonly string[],
): void {
	try {
		const feature = deriveFeatureFromPath(path);
		const errorClass = classifyError(error);

		// Resolve organization_id from the best available signal —
		// tenantContext if the request reached that middleware, else
		// session.activeOrganizationId, else "personal".
		let orgId: string | null | undefined;
		if (context.tenantContext?.type === "organization") {
			orgId = context.tenantContext.organizationId ?? null;
		} else if (context.session?.activeOrganizationId) {
			orgId = context.session.activeOrganizationId;
		} else {
			orgId = null; // -> "personal"
		}

		appErrorsTotal.inc({
			service: SERVICE,
			feature,
			error_class: errorClass,
			organization_id: organizationLabel(orgId),
		});
		// Mirror to App Insights — the auto-instrumented `requests` and
		// `exceptions` tables already capture HTTP errors, but the
		// `customMetrics` row gives the burn-rate KQL alert rules a stable,
		// labelled denominator across the (service, feature) axis the
		// monitoring v2 spec calls for.
		trackMetric("AppError", 1, {
			service: SERVICE,
			feature,
			errorClass,
			organizationId: organizationLabel(orgId),
		});
	} catch {
		// Never let the metric path crash a request.
	}
}

/**
 * Global oRPC error-recording middleware.
 *
 * Wraps `next()` in a try/catch so that:
 *   - happy path: the metric is NOT touched.
 *   - error path: the metric is incremented exactly once with bounded labels.
 *
 * The middleware re-throws so downstream handlers (the existing handler.ts
 * onError hook) still log + serialize the error.
 */
export const errorMetricsMiddleware = os
	.$context<
		{
			headers: Headers;
		} & ErrorMetricsContext
	>()
	.middleware(async ({ context, next, path }) => {
		try {
			return await next();
		} catch (error) {
			recordProcedureError(error, context, path);
			throw error;
		}
	});
