/**
 * Error classification for the automatic audit-error middleware (D16).
 *
 * Maps a thrown value (ORPCError, ZodError, Prisma error, plain Error) to:
 *  - one of the `error.*` action keys exported from `@repo/database`
 *    (`ERROR_ACTIONS`),
 *  - an `AuditSeverityLevel` (`info` | `warning` | `error` | `critical`).
 *
 * Severity tuning rationale: uncaught `Error` -> `error` (not `critical`)
 * to avoid alert fatigue. Operators can promote critical via a downstream
 * alerting rule keyed off `action: "error.internal"` if needed.
 *
 * Spec: docs/audit-log/README.md
 * D16 (automatic error capture).
 */

import type { AuditSeverityLevel, ErrorAction } from "@repo/database";

export interface ErrorClassification {
	action: ErrorAction;
	severity: AuditSeverityLevel;
}

/**
 * ORPCError code -> action + severity. Codes not in this map fall through
 * to the `UNHANDLED_CLASSIFICATION` constant below.
 */
const ORPC_CODE_TO_CLASSIFICATION: Record<string, ErrorClassification> = {
	FORBIDDEN: { action: "error.permission_denied", severity: "warning" },
	UNAUTHORIZED: { action: "error.permission_denied", severity: "warning" },
	NOT_FOUND: { action: "error.not_found", severity: "info" },
	BAD_REQUEST: { action: "error.validation", severity: "info" },
	TOO_MANY_REQUESTS: { action: "error.rate_limited", severity: "warning" },
	SERVICE_UNAVAILABLE: { action: "error.unavailable", severity: "error" },
	TIMEOUT: { action: "error.timeout", severity: "error" },
	CONFLICT: { action: "error.conflict", severity: "warning" },
	INTERNAL_SERVER_ERROR: { action: "error.internal", severity: "error" },
};

/**
 * Fallback for anything we cannot classify deterministically. Uncaught =
 * `error` not `critical` so a single dropped exception doesn't page SRE.
 */
const UNHANDLED_CLASSIFICATION: ErrorClassification = {
	action: "error.internal",
	severity: "error",
};

/**
 * Prisma known-request error codes we map specifically. Anything else
 * falls through to the unhandled bucket (treated as an internal error).
 *
 * See https://www.prisma.io/docs/reference/api-reference/error-reference
 */
const PRISMA_CODE_TO_CLASSIFICATION: Record<string, ErrorClassification> = {
	P2002: { action: "error.conflict", severity: "warning" }, // unique constraint
	P2025: { action: "error.not_found", severity: "info" }, // record not found
};

/**
 * Read a property off an unknown without crashing. Used to duck-type
 * thrown values that may not be `instanceof` what we expect (e.g. across
 * package-boundary class identity issues when modules are dual-loaded).
 */
function safeRead<T = unknown>(value: unknown, key: string): T | undefined {
	if (value && typeof value === "object" && key in value) {
		return (value as Record<string, unknown>)[key] as T;
	}
	return undefined;
}

/**
 * Classify a thrown value into an `error.*` action key and severity. Pure
 * function — never throws, returns the `UNHANDLED_CLASSIFICATION` fallback
 * for anything unrecognized.
 */
export function classifyError(err: unknown): ErrorClassification {
	if (!err || typeof err !== "object") {
		return UNHANDLED_CLASSIFICATION;
	}

	// ORPCError carries a `code` string that drives most of the mapping.
	const code = safeRead<string>(err, "code");
	if (typeof code === "string" && code in ORPC_CODE_TO_CLASSIFICATION) {
		return ORPC_CODE_TO_CLASSIFICATION[code]!;
	}

	// Zod failures: name === "ZodError". We treat them as BAD_REQUEST.
	const name = safeRead<string>(err, "name");
	if (name === "ZodError") {
		return { action: "error.validation", severity: "info" };
	}

	// Prisma errors: known-request errors carry a `code` like "P2002".
	// PrismaClientUnknownRequestError / RustPanicError do NOT carry a code
	// but their constructor name still starts with "PrismaClient".
	if (typeof name === "string" && name.startsWith("PrismaClient")) {
		if (
			name === "PrismaClientUnknownRequestError" ||
			name === "PrismaClientRustPanicError" ||
			name === "PrismaClientInitializationError"
		) {
			return { action: "error.internal", severity: "critical" };
		}
		// PrismaClientKnownRequestError carries `code: "P####"`.
		if (typeof code === "string" && code in PRISMA_CODE_TO_CLASSIFICATION) {
			return PRISMA_CODE_TO_CLASSIFICATION[code]!;
		}
		// Any other known-request code -> internal error.
		return { action: "error.internal", severity: "error" };
	}

	return UNHANDLED_CLASSIFICATION;
}
