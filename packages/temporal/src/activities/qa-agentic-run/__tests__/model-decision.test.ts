/**
 * The runner's model call, which used to make every test case impossible to
 * pass.
 *
 * Three behaviours are pinned, because three separate causes produce the same
 * `generateObject` sentence and each needed a different fix:
 *
 *  - an output budget is ALWAYS sent, so a reasoning deployment cannot spend its
 *    default allowance on hidden reasoning and return nothing;
 *  - a reply that is prose-wrapped JSON still yields a decision, so a deployment
 *    that ignores `response_format` is survivable;
 *  - the failure sentence names WHICH of the three happened, because the person
 *    diagnosing it reads the run detail, not Log Analytics.
 */

import {
	type FinishReason,
	type LanguageModelUsage,
	NoObjectGeneratedError,
} from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const generateObject = vi.fn();
const generateText = vi.fn();

vi.mock("@repo/ai", () => ({
	generateObject: (...args: unknown[]) => generateObject(...args),
	generateText: (...args: unknown[]) => generateText(...args),
	NoObjectGeneratedError: {
		isInstance: (err: unknown) => NoObjectGeneratedError.isInstance(err),
	},
}));

const {
	DECISION_OUTPUT_TOKEN_CEILING,
	decideWithModel,
	describeModelFailure,
	extractJsonObject,
} = await import("../model-decision");

const USAGE: LanguageModelUsage = {
	inputTokens: 3200,
	inputTokenDetails: {
		noCacheTokens: 3200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	outputTokens: 0,
	outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
	totalTokens: 3200,
};

function parseFailure(text: string, finishReason: FinishReason) {
	return new NoObjectGeneratedError({
		message: "No object generated: could not parse the response.",
		text,
		finishReason,
		usage: USAGE,
		response: { id: "r", timestamp: new Date(0), modelId: "m" },
	});
}

const ActSchema = z.object({
	kind: z.string().optional(),
	role: z.string().optional(),
	name: z.string().optional(),
});

/** Azure AI Foundry with no catalog caps — the bench's shape. */
const METADATA = { provider: "AZURE_AI_FOUNDRY" };

function call(overrides: Partial<Parameters<typeof decideWithModel>[0]> = {}) {
	return decideWithModel({
		// The model is opaque to this module — it is handed straight to the SDK,
		// which is mocked, so a marker object is the honest stand-in.
		model: "model" as never,
		metadata: METADATA,
		schema: ActSchema,
		prompt: "decide the step",
		jsonContract: "Reply with a single JSON object.",
		heartbeatDetails: { step: 1 },
		...overrides,
	});
}

beforeEach(() => {
	generateObject.mockReset();
	generateText.mockReset();
});

describe("decideWithModel", () => {
	it("sends an explicit output budget even when the catalog knows no cap", async () => {
		generateObject.mockResolvedValue({ object: { kind: "click" } });

		await call();

		// The regression: with no budget the SDK sends no `max_tokens` at all, and
		// a reasoning deployment answers with an empty body at its own default.
		expect(generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: DECISION_OUTPUT_TOKEN_CEILING,
			}),
		);
	});

	it("clamps the budget down to the model's catalog cap rather than over-asking", async () => {
		generateObject.mockResolvedValue({ object: {} });

		await call({
			metadata: { provider: "AZURE_AI_FOUNDRY", maxOutputTokens: 4_096 },
		});

		expect(generateObject).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 4_096 }),
		);
	});

	it("relaxes strict JSON schema, which an optional-heavy schema is rejected under", async () => {
		generateObject.mockResolvedValue({ object: {} });

		await call();

		expect(generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				providerOptions: { openai: { strictJsonSchema: false } },
			}),
		);
	});

	it("returns the object without a second call when the schema is honoured", async () => {
		generateObject.mockResolvedValue({
			object: { kind: "click", name: "Sign in" },
		});

		const decision = await call();

		expect(decision).toEqual({
			value: { kind: "click", name: "Sign in" },
			via: "object",
			calls: 1,
		});
		expect(generateText).not.toHaveBeenCalled();
	});

	it("recovers a decision from a prose-wrapped reply when the deployment ignores the schema", async () => {
		generateObject.mockRejectedValue(
			parseFailure("I would click Sign in.", "stop"),
		);
		generateText.mockResolvedValue({
			text: 'Sure — here you go:\n```json\n{"kind":"click","role":"button","name":"Sign in"}\n```\nHope that helps.',
		});

		const decision = await call();

		expect(decision).toEqual({
			value: { kind: "click", role: "button", name: "Sign in" },
			via: "text",
			// TWO provider calls were spent. The run bills per call and refuses
			// above a cost cap, so reporting 1 here would let the cap leak by
			// exactly what a struggling deployment costs most.
			calls: 2,
		});
	});

	it("rethrows the ORIGINAL failure when the fallback also yields no object", async () => {
		const original = parseFailure("", "length");
		generateObject.mockRejectedValue(original);
		generateText.mockResolvedValue({ text: "I am afraid I cannot help." });

		// The original carries finishReason/usage/raw reply; the fallback's own
		// error would carry none of it, and the caller logs this one.
		await expect(call()).rejects.toBe(original);
	});

	it("reports the ORIGINAL failure when the fallback call itself throws", async () => {
		// The original carries finishReason / usage / raw reply, which is what
		// names the cause in the step observation. The fallback's own error (a
		// rate limit, say) would replace that diagnosis with a symptom.
		const original = parseFailure("", "length");
		generateObject.mockRejectedValue(original);
		generateText.mockRejectedValue(new Error("429 Too Many Requests"));

		await expect(call()).rejects.toBe(original);
	});

	it("does not retry a transport or auth failure, which no rewording fixes", async () => {
		const boom = new TypeError("fetch failed");
		generateObject.mockRejectedValue(boom);

		await expect(call()).rejects.toBe(boom);
		expect(generateText).not.toHaveBeenCalled();
	});
});

describe("extractJsonObject", () => {
	it("ignores a brace inside a string rather than ending the object early", () => {
		expect(
			extractJsonObject(
				'{"observation":"saw a {curly} brace","met":true}',
			),
		).toEqual({ observation: "saw a {curly} brace", met: true });
	});

	it("survives an escaped quote inside a string", () => {
		expect(
			extractJsonObject('{"observation":"it said \\"Saved\\""}'),
		).toEqual({
			observation: 'it said "Saved"',
		});
	});

	it("returns null for prose with no object at all", () => {
		expect(
			extractJsonObject("I would click the Sign in button."),
		).toBeNull();
	});

	it("returns null for an unterminated object rather than guessing", () => {
		expect(extractJsonObject('{"kind":"cl')).toBeNull();
	});
});

describe("describeModelFailure", () => {
	it("names a token cap, which is a budget fix", () => {
		expect(
			describeModelFailure(parseFailure('{"kind":"cl', "length")),
		).toContain("cut off by the model's output limit");
	});

	it("names an empty reply, which is capacity or auth", () => {
		expect(describeModelFailure(parseFailure("", "stop"))).toContain(
			"returned an empty reply",
		);
	});

	it("quotes the prose, which is a provider ignoring the schema", () => {
		expect(
			describeModelFailure(
				parseFailure("I would click Sign in.", "stop"),
			),
		).toContain("I would click Sign in.");
	});

	it("passes a non-parse error through untouched", () => {
		expect(describeModelFailure(new TypeError("fetch failed"))).toBe(
			"fetch failed",
		);
	});
});
