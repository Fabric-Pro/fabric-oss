import {
	COMMON_ORPC_ERROR_DEFS,
	fallbackORPCErrorMessage,
	isORPCErrorJson,
} from "@orpc/client";

const RESPONSE_TEXT_LIMIT = 200;

/** Whether a response body is the error envelope the API's own oRPC handler writes. */
export function isRpcErrorEnvelope(text: string): boolean {
	try {
		const parsed: unknown = JSON.parse(text);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"json" in parsed &&
			isORPCErrorJson(parsed.json)
		);
	} catch {
		return false;
	}
}

/**
 * An oRPC error response for a failure the API did not write itself — a
 * proxy's HTML page, a platform's JSON error, malformed JSON. Without this the
 * client turns it into a generic error and drops the server's text (Fizzy
 * #2249).
 *
 * The code and message are the ones oRPC would pick for the status, so what a
 * toast shows is unchanged and no raw HTML reaches the UI. The server's own
 * text rides in `data.responseText`, which the failure log prints.
 */
export function rpcErrorResponse(
	status: number,
	responseText: string,
): Response {
	const code =
		Object.entries(COMMON_ORPC_ERROR_DEFS).find(
			([, def]) => def.status === status,
		)?.[0] ?? "MALFORMED_ORPC_ERROR_RESPONSE";
	const text = responseText.trim();
	return new Response(
		JSON.stringify({
			json: {
				defined: false,
				code,
				status,
				message: fallbackORPCErrorMessage(code, undefined),
				data: {
					responseText:
						text.length > RESPONSE_TEXT_LIMIT
							? `${text.slice(0, RESPONSE_TEXT_LIMIT)}…`
							: text,
				},
			},
			meta: [],
		}),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}
