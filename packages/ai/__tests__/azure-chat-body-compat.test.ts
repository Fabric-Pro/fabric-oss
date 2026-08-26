import { describe, expect, it } from "vitest";
import { applyAzureChatBodyCompat } from "../model-factory";

describe("applyAzureChatBodyCompat", () => {
	it("flips strict json_schema structured outputs to non-strict (Bug #1681)", () => {
		// @ai-sdk/openai defaults strictJsonSchema=true, which Azure rejects with
		// a 400 when the Zod schema has optional fields. Force non-strict.
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: { name: "Proposal", strict: true, schema: {} },
			},
		} as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4.1-mini");
		expect(modified).toBe(true);
		expect(
			(
				body.response_format as {
					json_schema: { strict: boolean };
				}
			).json_schema.strict,
		).toBe(false);
	});

	it("leaves an already non-strict json_schema untouched", () => {
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: { name: "Proposal", strict: false, schema: {} },
			},
		} as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4.1-mini");
		expect(modified).toBe(false);
	});

	it("removes temperature (Azure deployments may reject it)", () => {
		const body = { temperature: 0.7, messages: [] } as Record<
			string,
			unknown
		>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(true);
		expect(body.temperature).toBeUndefined();
	});

	it("converts max_tokens → max_completion_tokens for modern models", () => {
		const body = { max_tokens: 256 } as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(true);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(256);
	});

	it("keeps max_tokens for legacy models (gpt-4 / gpt-35)", () => {
		const body = { max_tokens: 256 } as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4");
		expect(modified).toBe(false);
		expect(body.max_tokens).toBe(256);
	});

	it("returns false and leaves a plain body unchanged", () => {
		const body = { messages: [{ role: "user", content: "hi" }] } as Record<
			string,
			unknown
		>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(false);
		expect(body).toEqual({ messages: [{ role: "user", content: "hi" }] });
	});
});
