/**
 * Shared oRPC RPC-protocol mock helpers for the Azure DevOps code-repo E2E specs.
 *
 * These mirror the canonical envelope used across the suite
 * (`tests/gitlab-issues-sync.spec.ts`, `tests/pm-import-filtering.spec.ts`):
 *   - REQUESTS arrive as `{ json: T }` (the RPCLink `StandardRPCSerializer`).
 *   - SUCCESS responses are `{ json: payload }`.
 *   - ERROR responses are `{ json: { defined, code, status, message, data } }`
 *     with an HTTP status that `@orpc/client`'s `isORPCErrorStatus` accepts, so
 *     the client reconstructs a real `ORPCError` whose `.message` surfaces to the
 *     UI (verified against `@orpc/client@1.14.0` `isORPCErrorJson`, which requires
 *     `defined` + `code` + `status` + `message`).
 */

/** Unwrap the `{ json: T }` request envelope the oRPC RPCLink posts. */
export function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

/** Wrap a payload in the `{ json: T }` success-response envelope. */
export function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

/**
 * Build the `{ json: { ... } }` error-response body the oRPC client deserializes
 * into an `ORPCError`. Pair it with `route.fulfill({ status })` using the SAME
 * status (must be a valid ORPC-error status, e.g. 400/401/403/404/409).
 */
export function orpcErrorResponse(
	code: string,
	status: number,
	message: string,
): string {
	return JSON.stringify({
		json: { defined: false, code, status, message, data: {} },
	});
}
