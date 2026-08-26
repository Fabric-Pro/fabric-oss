import { beforeEach, describe, expect, it, vi } from "vitest";

// The activity dynamically imports `ai` (generateText) + `@repo/ai`
// (getAIModel). vitest's vi.mock intercepts both static and dynamic imports,
// so these factories back the `await import(...)` calls inside the activity.
const generateText = vi.fn();
vi.mock("ai", () => ({
	generateText: (...a: unknown[]) => generateText(...a),
}));
vi.mock("@repo/ai", () => ({
	getAIModel: vi.fn().mockResolvedValue({}),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { analyzeIntentClarityActivity } from "../clarification";

describe("analyzeIntentClarityActivity", () => {
	beforeEach(() => {
		generateText.mockReset();
	});

	it("returns needsClarification:false for an empty message without calling the model", async () => {
		const res = await analyzeIntentClarityActivity({
			message: "   ",
			userId: "u",
		});
		expect(res.needsClarification).toBe(false);
		expect(generateText).not.toHaveBeenCalled();
	});

	it("returns the question and caps options at 3 when the model flags ambiguity", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: true,
				question: "Which environment should I target?",
				options: ["staging", "production", "local", "a fourth option"],
				reasoning: "unclear deploy target",
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "deploy it",
			userId: "u",
		});

		expect(res.needsClarification).toBe(true);
		expect(res.question).toBe("Which environment should I target?");
		// 4 supplied → capped to 3.
		expect(res.options).toEqual(["staging", "production", "local"]);
	});

	it("returns needsClarification:false when the model judges the request clear", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: false,
				reasoning: "clear enough to act",
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "add a dark-mode toggle to the settings page",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("does not pause when the model flags ambiguity but supplies no question", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({ needsClarification: true, question: "   " }),
		});

		const res = await analyzeIntentClarityActivity({
			message: "do the thing",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("is fail-safe: returns needsClarification:false when the model call throws", async () => {
		generateText.mockRejectedValue(new Error("provider unavailable"));

		const res = await analyzeIntentClarityActivity({
			message: "anything",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("returns needsClarification:false when the model output has no JSON object", async () => {
		generateText.mockResolvedValue({
			text: "Sorry, I can't structure that.",
		});

		const res = await analyzeIntentClarityActivity({
			message: "anything",
			userId: "u",
		});

		expect(res.needsClarification).toBe(false);
	});

	it("drops non-string / empty options entries", async () => {
		generateText.mockResolvedValue({
			text: JSON.stringify({
				needsClarification: true,
				question: "Pick one",
				options: ["valid", "", 42, "  trimmed  "],
			}),
		});

		const res = await analyzeIntentClarityActivity({
			message: "ambiguous",
			userId: "u",
		});

		expect(res.needsClarification).toBe(true);
		expect(res.options).toEqual(["valid", "trimmed"]);
	});
});
