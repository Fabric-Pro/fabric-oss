/**
 * One log line per oRPC error response — 4xx as a warning, 5xx as an error
 * with the original `Error` attached so its stack survives — logged from the
 * FINAL response status, never guessed from the raw thrown error.
 *
 * Two interceptors, because no single hook both sees the raw error (with its
 * stack) AND knows the status oRPC will finally answer with:
 *
 *   - `createRpcErrorCaptureInterceptor`, wired as `interceptors`
 *     (deliberately NOT `clientInterceptors` — installed oRPC 1.15.2,
 *     node_modules/@orpc/server/dist/shared/server.CMf4nKky.mjs,
 *     `StandardHandler.handle`): `clientInterceptors` wrap only
 *     `createProcedureClient(...)`'s call, AFTER the request body has
 *     already been matched to a procedure and decoded. An input-decode
 *     failure (malformed body → BAD_REQUEST) throws from `codec.decode()`
 *     before that call ever happens, so `clientInterceptors` never see it —
 *     the exact gap in the two bare `logger.error(error)` calls this
 *     replaces. `interceptors` wrap matching + decode + the procedure call
 *     together, so a decode failure OR a procedure error both reach it, with
 *     the original `Error` and stack. It only CAPTURES that error (keyed by
 *     the request) and rethrows — it does not log, because at this point the
 *     final status is not decided yet (see below).
 *   - `createRpcErrorLoggingInterceptor`, wired as `rootInterceptors`: runs
 *     AFTER `handle()`'s own outer catch has already converted whatever the
 *     interceptors layer threw into a real response (`try { return await
 *     intercept(this.interceptors, …) } catch (e) { … return { matched:
 *     true, response }; }`), so `next()` here always resolves — never
 *     rejects — with the FINAL `response.status`. That status is the one
 *     source of truth for 4xx-vs-5xx and for BAD_REQUEST-vs-other: a
 *     procedure that raises a raw (non-`ORPCError`) `SyntaxError` itself —
 *     say, `JSON.parse` on stored data — is rethrown UNCHANGED by
 *     `createProcedureClient` (node_modules/@orpc/server/dist/shared/
 *     server.DEBcqOjg.mjs:104-109,147-148, `validateError` only transforms
 *     `instanceof ORPCError`) and becomes a 500, exactly like any other
 *     procedure bug — indistinguishable, by error TYPE alone, from the
 *     `SyntaxError` `codec.decode()` throws for a malformed body, which
 *     becomes a 400. Classifying by the thrown error's type (an earlier
 *     version of this file did) got that case backwards; classifying by the
 *     status oRPC actually decided cannot.
 *
 * The two share a `WeakMap` keyed by `options.request` (`StandardLazyRequest`
 * — the SAME object reference the fetch adapter constructs once per request
 * and threads through `rootInterceptors` → `runWithSpan` → `interceptors`
 * unchanged, verified in the source above) to carry the captured error from
 * where it is thrown to where the status is known.
 *
 * Never logs the input payload — only the procedure path, the error's code/
 * status, and a message truncated to 300 characters. `correlationId` is not
 * added explicitly: `@repo/logs`'s own AsyncLocalStorage reporter stamps it
 * onto every entry (see `packages/logs/lib/logger.ts`).
 */

import { ORPCError } from "@orpc/client";
import type { Context } from "@orpc/server";
import type {
	StandardHandleResult,
	StandardHandlerInterceptorOptions,
} from "@orpc/server/standard";
import { logger } from "@repo/logs";

/**
 * The shape oRPC's own `intercept()` helper (`@orpc/shared`, not a direct
 * dependency of this package — a phantom import would fail to resolve)
 * passes to each `interceptors`/`rootInterceptors` entry:
 * `StandardHandlerInterceptorOptions<T>` plus the `next()` continuation.
 * Defined inline rather than importing `@orpc/shared`'s `Interceptor` type;
 * structurally identical, so it slots into `RPCHandlerOptions.interceptors` /
 * `.rootInterceptors` (and the OpenAPI equivalents) the same way.
 */
type RpcInterceptor<T extends Context> = (
	options: StandardHandlerInterceptorOptions<T> & {
		next: () => Promise<StandardHandleResult>;
	},
) => Promise<StandardHandleResult>;

const MAX_MESSAGE_CHARS = 300;

function truncateMessage(message: string): string {
	return message.length > MAX_MESSAGE_CHARS
		? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`
		: message;
}

/**
 * The procedure path, computed the same way `StandardHandler.handle` itself
 * computes it before matching (`prefix2 ? url.pathname.replace(prefix2, "")
 * : url.pathname`, then trimmed). Recomputed from the URL rather than read
 * off the match (not available at either interception level) — identical
 * value for any request that matched a route, not an approximation.
 */
function procedurePathFromRequest(
	url: URL,
	prefix: string | undefined,
): string {
	const pathname = prefix ? url.pathname.replace(prefix, "") : url.pathname;
	return pathname.replace(/^\/+|\/+$/g, "");
}

/**
 * Carries the raw thrown error (if any) from the `interceptors`-level
 * capture to the `rootInterceptors`-level logger, keyed by the shared
 * `StandardLazyRequest` object — see the file header for why that reference
 * is stable across the two levels for one request. A `WeakMap` so an entry
 * for a request that somehow never reaches the logging step (it always
 * should) is not a leak.
 */
const capturedErrors = new WeakMap<object, unknown>();

/** `code` when the thrown error is not an `ORPCError` — the final status is
 *  the only classification available at the logging level (see file
 *  header), so this is a status→code mapping, not a code guess. */
function deriveCode(error: unknown, status: number): string {
	if (error instanceof ORPCError) {
		return error.code;
	}
	return status === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
}

function deriveMessage(error: unknown, status: number): string {
	if (error instanceof Error) {
		return error.message;
	}
	return status >= 500 ? "Internal server error" : "Request failed";
}

/**
 * `interceptors` entry: captures the raw thrown error (matching or decode
 * failure, or a procedure error rethrown unchanged by `createProcedureClient`
 * — see file header) and rethrows unchanged. Never logs — see
 * `createRpcErrorLoggingInterceptor` for why logging waits for the final
 * status.
 */
export function createRpcErrorCaptureInterceptor<
	T extends Context = Context,
>(): RpcInterceptor<T> {
	return async (options) => {
		try {
			return await options.next();
		} catch (error) {
			capturedErrors.set(options.request, error);
			throw error;
		}
	};
}

/**
 * `rootInterceptors` entry: runs after `handle()`'s own outer catch has
 * already turned any thrown error into a real response, so `next()` here
 * always resolves. Logs exactly once, from `response.status` — 4xx as
 * `logger.warn`, 5xx as `logger.error` with the captured `Error` (if the
 * failure originated as one) so its stack survives.
 */
export function createRpcErrorLoggingInterceptor<
	T extends Context = Context,
>(): RpcInterceptor<T> {
	return async (options) => {
		const result = await options.next();
		const status = result.response?.status;
		if (status === undefined || status < 400) {
			return result;
		}

		const error = capturedErrors.get(options.request);
		capturedErrors.delete(options.request);
		const fields = {
			event: "rpc.error" as const,
			procedure: procedurePathFromRequest(
				options.request.url,
				options.prefix,
			),
			code: deriveCode(error, status),
			status,
			message: truncateMessage(deriveMessage(error, status)),
		};

		if (status >= 500) {
			logger.error(
				"rpc.error",
				fields,
				error instanceof Error ? error : undefined,
			);
		} else {
			logger.warn("rpc.error", fields);
		}

		return result;
	};
}
