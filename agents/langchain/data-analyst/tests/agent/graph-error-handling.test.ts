import { describe, it, expect } from "vitest";
import { __testing } from "@/lib/agent/graph";

const { sanitizeToolCallArgs, toFriendlyAgentError } = __testing;

describe("sanitizeToolCallArgs", () => {
	it("preserves inner-message identity for messages without tool_calls", () => {
		const messages = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		];
		const out = sanitizeToolCallArgs(messages);
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
	});

	it("passes through messages whose tool_calls all have valid object args (same reference)", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "t1", name: "create_view", args: { elements: [] } },
				],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		expect(out[0]).toBe(messages[0]);
	});

	it("coerces string args to {} when not parseable JSON", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "t1", name: "create_view", args: "" }],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as { tool_calls: Array<{ args: unknown }> }
		).tool_calls[0];
		expect(tc.args).toEqual({});
	});

	it("parses JSON-string args into a plain object", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "t1",
						name: "create_view",
						args: '{"elements":[{"type":"rect"}]}',
					},
				],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as { tool_calls: Array<{ args: unknown }> }
		).tool_calls[0];
		expect(tc.args).toEqual({ elements: [{ type: "rect" }] });
	});

	it("coerces array args to {} (Anthropic rejects arrays as tool_use.input)", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "t1", name: "create_view", args: [1, 2] }],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as { tool_calls: Array<{ args: unknown }> }
		).tool_calls[0];
		expect(tc.args).toEqual({});
	});

	it("coerces null / undefined args to {}", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "t1", name: "x", args: null },
					{ id: "t2", name: "y", args: undefined },
				],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const calls = (out[0] as { tool_calls: Array<{ args: unknown }> })
			.tool_calls;
		expect(calls[0].args).toEqual({});
		expect(calls[1].args).toEqual({});
	});

	it("coerces JSON-string that parses to null to {}", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "t1", name: "x", args: "null" }],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as { tool_calls: Array<{ args: unknown }> }
		).tool_calls[0];
		expect(tc.args).toEqual({});
	});

	it("coerces JSON-string that parses to an array to {}", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "t1", name: "x", args: "[1,2,3]" }],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as { tool_calls: Array<{ args: unknown }> }
		).tool_calls[0];
		expect(tc.args).toEqual({});
	});

	it("preserves other fields on tool_call entries", () => {
		const messages = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "t1",
						name: "create_view",
						args: "",
						type: "tool_call",
					},
				],
			},
		];
		const out = sanitizeToolCallArgs(messages);
		const tc = (
			out[0] as {
				tool_calls: Array<{ id: string; name: string; type: string }>;
			}
		).tool_calls[0];
		expect(tc.id).toBe("t1");
		expect(tc.name).toBe("create_view");
		expect(tc.type).toBe("tool_call");
	});
});

describe("toFriendlyAgentError", () => {
	it("translates the Anthropic tool_use.input validation error into a friendly message", () => {
		const raw =
			"messages.3.content.0.tool_use.input: Input should be a valid dictionary";
		const friendly = toFriendlyAgentError(raw);
		expect(friendly).not.toContain("messages.");
		expect(friendly).not.toContain("tool_use.input");
		expect(friendly).not.toContain("dictionary");
		expect(friendly.toLowerCase()).toContain("rephrasing");
	});

	it("translates 'Invalid tool_use' style errors", () => {
		const raw = "Invalid tool_use_id provided to the model";
		const friendly = toFriendlyAgentError(raw);
		expect(friendly).not.toContain("Invalid tool_use");
		expect(friendly.toLowerCase()).toContain("rephrasing");
	});

	it("translates rate-limit errors", () => {
		const friendly = toFriendlyAgentError("Error 429: rate limit exceeded");
		expect(friendly).not.toContain("429");
		expect(friendly.toLowerCase()).toContain("rate-limited");
	});

	it("translates context-length errors", () => {
		const friendly = toFriendlyAgentError(
			"prompt is too long for context length 200000",
		);
		expect(friendly.toLowerCase()).toContain("too long");
	});

	it("translates timeout errors", () => {
		const friendly = toFriendlyAgentError("Request timed out after 60000ms");
		expect(friendly.toLowerCase()).toContain("too long");
	});

	it("returns a generic friendly fallback for unknown errors", () => {
		const friendly = toFriendlyAgentError(
			"ECONNRESET: socket hang up at TLSSocket._destroyEnd",
		);
		expect(friendly).not.toContain("ECONNRESET");
		expect(friendly).not.toContain("TLSSocket");
		expect(friendly.toLowerCase()).toMatch(/problem|try again|rephrase/);
	});
});
