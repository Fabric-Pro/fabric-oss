/**
 * Safe JSON body for an UNEXPECTED (500-class) error (SOC 2 CC6.1 / CC7.1).
 *
 * In production the real message/stack is NOT returned to the client — raw
 * error text (DB/driver/internal exceptions) can leak schema, paths, and
 * internal state. Clients get a generic message; the real error is logged by
 * the caller (`logger.error(...)`) with the request's correlation id, so
 * support can still find it.
 *
 * In development the real message (and stack) is returned for debugging.
 *
 * Use this ONLY for unexpected catch-all errors. Intentional, user-facing
 * errors (ORPCError, validation, domain errors) are surfaced by oRPC's own
 * handler before reaching the Hono catch-all sites that use this helper.
 */
export function internalErrorBody(err: unknown): {
	error: string;
	message: string;
	stack?: string;
} {
	if (process.env.NODE_ENV === "development") {
		return {
			error: "Internal Server Error",
			message: err instanceof Error ? err.message : String(err),
			...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
		};
	}
	return {
		error: "Internal Server Error",
		message: "An unexpected error occurred.",
	};
}
