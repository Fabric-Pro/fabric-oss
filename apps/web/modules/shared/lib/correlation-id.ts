/**
 * Client-side correlation ID helpers.
 *
 * Every browser oRPC request generates a fresh correlation ID and forwards
 * it via the `X-Correlation-ID` header. The BE's `correlationIdMiddleware`
 * (packages/api/lib/correlation-id.ts) prefers an incoming header over
 * generating one, so the same ID propagates through the whole server-side
 * call stack — Prisma queries, audit log writes, started Temporal
 * workflows, structured logs — without any per-call wiring.
 *
 * For surfacing the ID back to the user (e.g. a "Reference ID" in an
 * error toast), `currentCorrelationId()` returns the most recent
 * response's `X-Correlation-ID` header captured by the fetch interceptor.
 *
 * Browser-only file — must not import anything that pulls
 * `node:async_hooks` into the client bundle.
 */

/**
 * Generate a new client-side correlation ID for the next outbound request.
 * Uses `crypto.randomUUID()` when available (secure contexts) and falls
 * back to a base36 random string elsewhere.
 */
export function generateClientCorrelationId(): string {
	const cryptoObj = globalThis.crypto as
		| { randomUUID?: () => string }
		| undefined;
	if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
		return `req_${cryptoObj.randomUUID()}`;
	}
	return `req_${Math.random().toString(36).slice(2, 18)}`;
}

// Module-level holder for the last response's correlation ID. Updated by
// the fetch interceptor in `orpc-client.ts` on every response so callers
// can quote it in error toasts: "If this keeps failing, share this
// reference ID with support: req_<…>".
let lastResponseCorrelationId: string | null = null;

/**
 * Record the correlation ID from a response (the BE echoes it back via
 * the `X-Correlation-ID` response header). Called by the fetch
 * interceptor in `orpc-client.ts` — most consumers should not call this
 * directly.
 */
export function captureResponseCorrelationId(headers: Headers | null): void {
	if (!headers) {
		return;
	}
	const value =
		headers.get("x-correlation-id") ?? headers.get("X-Correlation-ID");
	if (value && value.trim().length > 0) {
		lastResponseCorrelationId = value.trim();
	}
}

/**
 * Get the correlation ID from the most recent oRPC response. Returns
 * `null` before any request has been made. Useful for surfacing a
 * traceable reference in user-facing error toasts.
 */
export function currentCorrelationId(): string | null {
	return lastResponseCorrelationId;
}
