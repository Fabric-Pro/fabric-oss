/**
 * `formatLogArgs` builds the body of the OTLP log record a console call
 * forwards to App Insights. `JSON.stringify` on an `Error` is "{}", so a
 * failure logged as `console.error("...:", error)` used to reach App Insights
 * with no detail (Fizzy #3519). A logged error now carries its class, message,
 * status/code and cause chain, but none of its other own properties: an
 * AI SDK error holds the request body, which repeats the prompt.
 */
import { describe, expect, it } from "vitest";
import { formatLogArgs } from "../src/telemetry";

/** The shape the AI SDK threw during the gateway credential outage. */
function gatewayFailure(): Error {
	const cause = Object.assign(
		new Error(
			"AI Gateway authentication failed: Invalid API key or token.",
		),
		{
			name: "GatewayAuthenticationError",
			statusCode: 401,
			requestBodyValues: {
				input: ["You revise a proposal for Example Org."],
			},
		},
	);
	return new Error(
		"Batch embedding generation failed: AI Gateway authentication failed: Invalid API key or token.",
		{ cause },
	);
}

describe("formatLogArgs", () => {
	it("keeps a logged error's message, status and cause instead of {}", () => {
		const body = formatLogArgs([
			"[SearchTools] Semantic server search failed:",
			gatewayFailure(),
		]);

		expect(body).toBe(
			"[SearchTools] Semantic server search failed: Error: Batch embedding generation failed: AI Gateway authentication failed: Invalid API key or token. [cause: GatewayAuthenticationError: AI Gateway authentication failed: Invalid API key or token. [statusCode=401]]",
		);
	});

	it("leaves the error's other properties, such as the request body, out", () => {
		expect(formatLogArgs([gatewayFailure()])).not.toContain("Example Org");
	});

	it("describes an error nested in a logged object", () => {
		const body = formatLogArgs([
			"[Activity] Failed:",
			{
				step: "embed",
				error: Object.assign(new Error("boom"), { code: "E1" }),
			},
		]);

		expect(body).toBe(
			'[Activity] Failed: {"step":"embed","error":"Error: boom [code=E1]"}',
		);
	});

	it("does not serialize a cause that is not an Error", () => {
		const response = { headers: { authorization: "Bearer example-token" } };

		expect(
			formatLogArgs([new Error("request failed", { cause: response })]),
		).toBe("Error: request failed [cause: [object]]");
		expect(
			formatLogArgs([new Error("timed out", { cause: "ETIMEDOUT" })]),
		).toBe("Error: timed out [cause: ETIMEDOUT]");
	});

	it("stops following the cause chain after three levels", () => {
		let error = new Error("level 0");
		for (let level = 1; level <= 5; level++) {
			error = new Error(`level ${level}`, { cause: error });
		}

		const body = formatLogArgs([error]);

		expect(body).toContain("level 2");
		expect(body).not.toContain("level 1");
	});

	it("still writes plain objects and primitives as before", () => {
		expect(formatLogArgs(["n", 3, null, undefined, { a: 1 }])).toBe(
			'n 3 null undefined {"a":1}',
		);
	});

	it("does not throw on a circular object", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(formatLogArgs(["x", circular])).toBe("x [object Object]");
	});
});
