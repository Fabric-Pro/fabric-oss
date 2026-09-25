/**
 * Fizzy #2249: an error response the API did not write itself (a proxy's HTML
 * page, a platform's JSON error) reached the client as a generic error with the
 * server's text dropped. It is now rewrapped as oRPC's error envelope, keeping
 * the text in `data.responseText`.
 */

import {
	isRpcErrorEnvelope,
	rpcErrorResponse,
} from "@shared/lib/rpc-error-envelope";
import { describe, expect, it } from "vitest";

describe("isRpcErrorEnvelope", () => {
	it("recognizes the API's own error envelope", () => {
		const body = JSON.stringify({
			json: {
				defined: false,
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
				message: "Failed to list prompts",
			},
			meta: [],
		});

		expect(isRpcErrorEnvelope(body)).toBe(true);
	});

	it("rejects an HTML page, a foreign JSON error and malformed JSON", () => {
		expect(isRpcErrorEnvelope("<html>502 Bad Gateway</html>")).toBe(false);
		expect(
			isRpcErrorEnvelope(
				JSON.stringify({ error: { message: "timeout" } }),
			),
		).toBe(false);
		expect(isRpcErrorEnvelope('{"json": ')).toBe(false);
	});
});

describe("rpcErrorResponse", () => {
	it("uses oRPC's code and message for the status and keeps the server text in data", async () => {
		const response = rpcErrorResponse(
			502,
			"  <html>502 Bad Gateway upstream</html>\n",
		);

		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body.json).toEqual({
			defined: false,
			code: "BAD_GATEWAY",
			status: 502,
			message: "Bad Gateway",
			data: { responseText: "<html>502 Bad Gateway upstream</html>" },
		});
		expect(isRpcErrorEnvelope(JSON.stringify(body))).toBe(true);
	});

	it("truncates a long server response", async () => {
		const body = await rpcErrorResponse(500, "x".repeat(500)).json();

		expect(body.json.data.responseText).toBe(`${"x".repeat(200)}…`);
	});
});
