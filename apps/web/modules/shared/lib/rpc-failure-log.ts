import { maskRoute, queueRpcFailureReport } from "./rpc-failure-report";

/**
 * 4xx codes a consumer is expected to handle through its query's `error`.
 * The common case is non-admin members hitting billing-gated endpoints
 * (FORBIDDEN from ORG_BILLING_READ) — not silent any more (Fizzy #2249
 * follow-up: silence hid the client half of an incident from anyone
 * grepping the console), but `console.warn` rather than `console.error` so
 * it does not become a Next.js dev-overlay "Console Error" for something
 * the consumer handles.
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
 * Log a failed oRPC call, and report to the server the two shapes it never
 * saw itself. Names the procedure, because a transport failure on its own
 * logs only "TypeError: Failed to fetch" and does not say which request
 * failed (Fizzy #2249).
 *
 * The report only ever covers what the API's own `rpc.error` log line
 * (`packages/api/orpc/rpc-error-logging.ts`) could not have: a transport
 * failure (`fetch` itself never got a response — there is no server-side
 * request to have logged) and a "rewrapped" error page (`data.responseText`
 * — a proxy or platform page, again never reaching the API's own handler).
 * An ordinary `ORPCError` the API returned, expected code or not, is already
 * in that log line; reporting it again here would double-count one failure
 * across two processes.
 */
export function logRpcFailure(error: unknown, path: readonly string[]): void {
	const procedure = path.join("/");
	let responseText: string | undefined;
	let code: string | undefined;
	let status: number | undefined;
	if (typeof error === "object" && error !== null) {
		if ("name" in error && error.name === "AbortError") {
			return;
		}
		if ("code" in error && typeof error.code === "string") {
			code = error.code;
		}
		if ("status" in error && typeof error.status === "number") {
			status = error.status;
		}
		if (
			"data" in error &&
			typeof error.data === "object" &&
			error.data !== null &&
			"responseText" in error.data &&
			typeof error.data.responseText === "string"
		) {
			responseText = error.data.responseText;
		}
	}

	const label = `oRPC ${procedure} failed:`;
	if (responseText) {
		// A rewrapped proxy/platform page. Always the full console.error with
		// the server's own text — its derived `code` reusing an "expected"
		// value (a proxy 404 page, say) does not make it OUR NOT_FOUND.
		console.error(label, error, `Server response: ${responseText}`);
	} else if (code && EXPECTED_4XX_CODES.has(code)) {
		console.warn(label, { procedure, code }, error);
	} else {
		console.error(label, error);
	}

	const route =
		typeof window !== "undefined"
			? maskRoute(window.location.pathname)
			: "";
	if (responseText) {
		// The API's own handler never ran for this one, so it has nothing
		// logged for it.
		queueRpcFailureReport({
			procedure,
			kind: "error-page",
			status,
			code,
			route,
		});
	} else if (!code) {
		// No `.code` at all means this never became an ORPCError — a raw
		// transport failure (`fetch` threw before any response existed).
		queueRpcFailureReport({
			procedure,
			kind: "transport",
			route,
		});
	}
}
