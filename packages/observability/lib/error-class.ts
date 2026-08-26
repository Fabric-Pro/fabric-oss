/**
 * Error class taxonomy — maps thrown exceptions onto the coarse `error_class`
 * label values used by `app_errors_total`.
 *
 * The set is intentionally small (8 values) to keep cardinality bounded. New
 * classes require an explicit broader review.
 */

import type { ErrorClassLabel } from "./app-metrics";

/**
 * Classify an arbitrary thrown value into one of the bounded error classes.
 *
 * Heuristics, in priority order:
 *   1. oRPC error codes — NOT_FOUND / UNAUTHORIZED / FORBIDDEN / CONFLICT
 *      etc. all collapse to "downstream_4xx" except VALIDATION-style codes
 *      which map to "validation".
 *   2. Native timeout / abort errors → "timeout".
 *   3. HTTP / fetch rate-limit signals (429, "rate limit" string match) →
 *      "rate_limit".
 *   4. Prisma errors → "downstream_4xx" (db constraint) or "5xx" (engine).
 *      We use "downstream_4xx" for known Prisma errors and "5xx" for
 *      unknown DB errors.
 *   5. Anything else with a 5xx-ish HTTP status → "5xx".
 *   6. Fall through: "unhandled".
 *
 * The function MUST be exception-safe — it is called from error paths and
 * MUST NOT throw. If it cannot classify, it returns "unknown".
 */
export function classifyError(error: unknown): ErrorClassLabel {
	try {
		if (error === null || error === undefined) {
			return "unknown";
		}

		// oRPC errors expose `.code` (string) and optionally `.status` (number)
		const errObj = error as {
			code?: string;
			status?: number;
			name?: string;
			message?: string;
		};

		const code = typeof errObj.code === "string" ? errObj.code : undefined;
		const name = typeof errObj.name === "string" ? errObj.name : undefined;
		const message =
			typeof errObj.message === "string" ? errObj.message : "";
		const status =
			typeof errObj.status === "number" ? errObj.status : undefined;

		// Validation errors (Zod, oRPC BAD_REQUEST)
		if (code === "BAD_REQUEST" || name === "ZodError") {
			return "validation";
		}

		// Common 4xx codes from oRPC — these are caller errors, not failures.
		if (
			code === "NOT_FOUND" ||
			code === "UNAUTHORIZED" ||
			code === "FORBIDDEN" ||
			code === "CONFLICT" ||
			code === "METHOD_NOT_ALLOWED"
		) {
			return "downstream_4xx";
		}

		// Rate-limit — oRPC code or HTTP status.
		if (code === "TOO_MANY_REQUESTS" || status === 429) {
			return "rate_limit";
		}

		// Timeout / abort signals.
		if (
			name === "AbortError" ||
			name === "TimeoutError" ||
			code === "TIMEOUT" ||
			/timed?\s*out|timeout/i.test(message)
		) {
			return "timeout";
		}

		// Prisma errors — known names start with "PrismaClient*Error".
		if (name?.startsWith("PrismaClient")) {
			// Validation / known-request errors are 4xx-ish (caller-side bug).
			// Engine crashes / unknown errors are 5xx.
			if (
				name === "PrismaClientValidationError" ||
				name === "PrismaClientKnownRequestError"
			) {
				return "downstream_4xx";
			}
			return "5xx";
		}

		// HTTP-style status code on the error object.
		if (typeof status === "number") {
			if (status >= 500) {
				return "5xx";
			}
			if (status === 429) {
				return "rate_limit";
			}
			if (status >= 400) {
				return "downstream_4xx";
			}
		}

		// oRPC server-side errors.
		if (
			code === "INTERNAL_SERVER_ERROR" ||
			code === "SERVICE_UNAVAILABLE"
		) {
			return "5xx";
		}

		return "unhandled";
	} catch {
		// Defensive: classifier itself must never throw.
		return "unknown";
	}
}
