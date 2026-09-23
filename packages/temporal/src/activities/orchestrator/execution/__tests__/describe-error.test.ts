import { describe, expect, it } from "vitest";
import { describeError } from "../describe-error";

describe("describeError", () => {
	it("reads an Error's message", () => {
		expect(describeError(new Error("boom"))).toBe("boom");
	});

	it("passes a string through", () => {
		expect(describeError("plain failure")).toBe("plain failure");
	});

	it("reads a JSON-RPC error", () => {
		expect(
			describeError({
				jsonrpc: "2.0",
				error: { code: -32603, message: "Resource not found: card 42" },
			}),
		).toBe("Resource not found: card 42");
	});

	it("reads a string .error and a nested .data.message", () => {
		expect(describeError({ error: "rate limited" })).toBe("rate limited");
		expect(describeError({ data: { message: "Forbidden" } })).toBe(
			"Forbidden",
		);
	});

	it("reads an MCP isError result's content text", () => {
		expect(
			describeError({
				isError: true,
				content: [
					{ type: "text", text: "Page not shared with integration" },
				],
			}),
		).toBe("Page not shared with integration");
	});

	it("serializes any other object instead of printing [object Object]", () => {
		const text = describeError({ code: 500, detail: "upstream" });
		expect(text).not.toContain("[object Object]");
		expect(text).toBe('{"code":500,"detail":"upstream"}');
	});

	it("never returns an empty or [object Object] string", () => {
		for (const value of [
			undefined,
			null,
			{},
			{ error: {} },
			new Error(""),
		]) {
			const text = describeError(value);
			expect(text).toBeTruthy();
			expect(text).not.toBe("[object Object]");
		}
	});

	it("survives a circular object", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(describeError(circular)).toBe("Unknown error");
	});
});
