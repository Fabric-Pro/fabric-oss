/**
 * 4xx codes a consumer is expected to handle through its query's `error`.
 * Logging them turns each one into a Next.js dev-overlay "Console Error" even
 * though the consumer handles it — the common case is non-admin members hitting
 * billing-gated endpoints (FORBIDDEN from ORG_BILLING_READ).
 */
const EXPECTED_4XX_CODES = new Set([
	"BAD_REQUEST",
	"UNAUTHORIZED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"UNPROCESSABLE_ENTITY",
	"TOO_MANY_REQUESTS",
]);

/**
 * Log a failed oRPC call that the consumer is not expected to handle: a server
 * error or a transport failure. Names the procedure, because a transport
 * failure on its own logs only "TypeError: Failed to fetch" and does not say
 * which request failed (Fizzy #2249).
 */
export function logRpcFailure(error: unknown, path: readonly string[]): void {
	if (typeof error === "object" && error !== null) {
		if ("name" in error && error.name === "AbortError") {
			return;
		}
		if (
			"code" in error &&
			typeof error.code === "string" &&
			EXPECTED_4XX_CODES.has(error.code)
		) {
			return;
		}
	}
	console.error(`oRPC ${path.join("/")} failed:`, error);
}
