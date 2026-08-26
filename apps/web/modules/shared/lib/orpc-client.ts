import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiRouterClient } from "@repo/api/orpc/router";
import { getBaseUrl } from "@repo/utils";
import {
	captureResponseCorrelationId,
	generateClientCorrelationId,
} from "./correlation-id";

/**
 * Custom fetch that converts non-JSON responses (e.g. HTML error pages) into
 * JSON so the oRPC client can parse them. Prevents "Cannot parse response body"
 * when the API returns HTML or other non-JSON content.
 *
 * Also captures the `X-Correlation-ID` response header so
 * `currentCorrelationId()` can surface it to error toasts / support flows.
 */
async function orpcFetch(
	request: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(request, init);
	// Stash the correlation ID echoed back by the server for later
	// retrieval via `currentCorrelationId()`. Safe on every response —
	// missing header is a no-op.
	captureResponseCorrelationId(response.headers);
	const contentType = response.headers.get("content-type") ?? "";

	// Streaming responses (oRPC event-iterators are delivered as Server-Sent
	// Events) MUST be passed through untouched. Reading the body here would
	// buffer the entire stream — breaking incremental delivery — and because
	// SSE is not JSON, the non-JSON branch below would otherwise convert the
	// whole stream into a bogus error response. The body is consumed by the
	// caller's async iterator instead.
	if (contentType.includes("text/event-stream")) {
		return response;
	}

	const text = await response.text();

	// Validate JSON for responses that claim to be JSON
	if (contentType.includes("application/json")) {
		try {
			JSON.parse(text);
		} catch {
			// Malformed JSON - return parseable error
			return new Response(
				JSON.stringify({
					error: "Internal Server Error",
					message: `Server returned invalid JSON: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
					status: response.status,
				}),
				{
					status: response.status >= 400 ? response.status : 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		return new Response(text, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	// Non-JSON response (e.g. HTML error page) - convert to JSON error
	return new Response(
		JSON.stringify({
			error: "Internal Server Error",
			message:
				response.status >= 400
					? `Server returned ${response.status}: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`
					: "Invalid response format from server",
			status: response.status,
		}),
		{
			status: response.status,
			headers: { "Content-Type": "application/json" },
		},
	);
}

const link = new RPCLink({
	url: `${getBaseUrl()}/api/rpc`,
	fetch: orpcFetch,
	headers: async () => {
		// Every request — browser AND SSR — must carry a correlation ID.
		// The BE's `correlationIdMiddleware` prefers an incoming header over
		// generating its own, so this lands a single ID that propagates
		// through every server-side hop (audit-log rows, structured logs,
		// Temporal workflow memos, downstream fetches).
		const correlationId = generateClientCorrelationId();

		if (typeof window !== "undefined") {
			return { "x-correlation-id": correlationId };
		}

		// SSR path: forward existing request headers (so cookies / auth /
		// upstream correlation are preserved) and only inject a new
		// correlation ID when the upstream request did not carry one.
		const { headers } = await import("next/headers");
		const reqHeaders = Object.fromEntries(await headers());
		return {
			...reqHeaders,
			"x-correlation-id": reqHeaders["x-correlation-id"] ?? correlationId,
		};
	},
	interceptors: [
		onError((error) => {
			if (error instanceof Error && error.name === "AbortError") {
				return;
			}

			// Don't noise the dev console with expected 4xx responses.
			// Permission denials, auth failures, missing resources, and
			// validation errors are routinely surfaced to consumers via
			// useQuery's `error` field — logging them here turns each one
			// into a Next.js dev-overlay "Console Error" even though the
			// consumer is handling them gracefully. Common case today:
			// non-admin members hitting billing-gated endpoints (FORBIDDEN
			// from ORG_BILLING_READ). Only log unexpected server errors.
			const expected4xxCodes = new Set([
				"BAD_REQUEST",
				"UNAUTHORIZED",
				"FORBIDDEN",
				"NOT_FOUND",
				"CONFLICT",
				"UNPROCESSABLE_ENTITY",
				"TOO_MANY_REQUESTS",
			]);
			const code = (error as { code?: unknown } | undefined)?.code;
			if (typeof code === "string" && expected4xxCodes.has(code)) {
				return;
			}

			console.error(error);
		}),
	],
});

export const orpcClient: ApiRouterClient = createORPCClient(link);
