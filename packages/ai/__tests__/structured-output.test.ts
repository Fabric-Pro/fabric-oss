/**
 * `requireStructuredOutput` keeps the error contract `generateObject` had when
 * structured calls move to `generateText` + `Output.object`. Each case runs the
 * same mock model through both APIs, so the parity is checked against the SDK
 * itself rather than a hand-written expectation.
 */
import {
	generateObject,
	generateText,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requireStructuredOutput } from "../lib/structured-output";

const schema = z.object({ title: z.string() });

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function modelAnswering(
	content: Array<
		{ type: "text"; text: string } | { type: "reasoning"; text: string }
	>,
	finishReason: "stop" | "length" | "content-filter",
) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content,
			finishReason: { unified: finishReason, raw: undefined },
			usage,
			warnings: [],
		}),
	});
}

async function structured(model: MockLanguageModelV4) {
	return requireStructuredOutput(
		generateText({
			model,
			output: Output.object({ schema }),
			prompt: "Name it.",
			maxRetries: 0,
		}),
	);
}

async function legacy(model: MockLanguageModelV4) {
	return generateObject({ model, schema, prompt: "Name it.", maxRetries: 0 });
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

describe("requireStructuredOutput", () => {
	it("returns the generateText result with the parsed output", async () => {
		const result = await structured(
			modelAnswering(
				[{ type: "text", text: '{"title":"Cats"}' }],
				"stop",
			),
		);

		expect(result.output).toEqual({ title: "Cats" });
		expect(result.finishReason).toBe("stop");
		expect(result.usage.inputTokens).toBe(10);
	});

	it.each(["length", "content-filter"] as const)(
		"raises NoObjectGeneratedError with finishReason %s when the model returns no text, as generateObject did",
		async (finishReason) => {
			const content = [
				{ type: "reasoning" as const, text: "Thinking..." },
			];

			// Without the helper, generateText surfaces only a bare
			// NoOutputGeneratedError, which carries no finishReason.
			const bare = await generateText({
				model: modelAnswering(content, finishReason),
				output: Output.object({ schema }),
				prompt: "Name it.",
				maxRetries: 0,
			});
			expect(() => bare.output).toThrow(NoOutputGeneratedError);

			const migrated = await rejectionOf(
				structured(modelAnswering(content, finishReason)),
			);
			const original = await rejectionOf(
				legacy(modelAnswering(content, finishReason)),
			);

			for (const error of [migrated, original]) {
				expect(NoObjectGeneratedError.isInstance(error)).toBe(true);
				expect((error as NoObjectGeneratedError).finishReason).toBe(
					finishReason,
				);
				expect(
					(error as NoObjectGeneratedError).usage?.inputTokens,
				).toBe(10);
			}
			expect((migrated as Error).message).toBe(
				(original as Error).message,
			);
		},
	);

	it("passes a schema mismatch through as the SDK's own NoObjectGeneratedError", async () => {
		const content = [{ type: "text" as const, text: '{"title":42}' }];

		const migrated = await rejectionOf(
			structured(modelAnswering(content, "stop")),
		);
		const original = await rejectionOf(
			legacy(modelAnswering(content, "stop")),
		);

		for (const error of [migrated, original]) {
			expect(NoObjectGeneratedError.isInstance(error)).toBe(true);
			expect((error as NoObjectGeneratedError).finishReason).toBe("stop");
			expect((error as NoObjectGeneratedError).text).toBe('{"title":42}');
		}
		expect((migrated as Error).message).toBe((original as Error).message);
	});

	it("rethrows a provider failure untouched", async () => {
		const failure = new Error("Upstream 503");
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw failure;
			},
		});

		await expect(structured(model)).rejects.toBe(failure);
	});
});
