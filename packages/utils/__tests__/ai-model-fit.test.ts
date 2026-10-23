import { describe, expect, it } from "vitest";
import { getAiModelFit } from "../lib/ai-model-fit";

const rated = {
	suitableForTasks: ["CHAT"],
	capabilities: ["TEXT"],
	qualityTier: "STANDARD",
};
describe("getAiModelFit", () => {
	it.each(["COMPLEX", "REASONING", "TOOL_CALLING", "CHAT", "EVAL", "SIMPLE"])(
		"checks suitability for %s",
		(taskType) => {
			expect(
				getAiModelFit({
					...rated,
					taskType,
					capabilities: ["TOOL_CALLING"],
				}),
			).toEqual(
				taskType === "CHAT"
					? null
					: { kind: "quality", reason: "not-suitable" },
			);
			expect(
				getAiModelFit({
					...rated,
					taskType,
					suitableForTasks: [taskType],
					capabilities: ["TOOL_CALLING"],
				}),
			).toBeNull();
		},
	);
	it("prioritizes missing tools over suitability", () => {
		expect(getAiModelFit({ ...rated, taskType: "TOOL_CALLING" })).toEqual({
			kind: "quality",
			reason: "no-tool-calling",
		});
		expect(
			getAiModelFit({
				...rated,
				taskType: "TOOL_CALLING",
				suitableForTasks: ["TOOL_CALLING"],
			}),
		).toEqual({ kind: "quality", reason: "no-tool-calling" });
		expect(
			getAiModelFit({
				...rated,
				taskType: "TOOL_CALLING",
				capabilities: undefined,
				suitableForTasks: ["TOOL_CALLING"],
			}),
		).toBeNull();
	});
	it.each(["COMPLEX", "REASONING", "EVAL"])(
		"flags basic tier for %s, after suitability",
		(taskType) => {
			expect(
				getAiModelFit({
					...rated,
					taskType,
					qualityTier: "BASIC",
					suitableForTasks: [taskType],
				}),
			).toEqual({ kind: "quality", reason: "basic-tier" });
			expect(
				getAiModelFit({ ...rated, taskType, qualityTier: "BASIC" }),
			).toEqual({ kind: "quality", reason: "not-suitable" });
		},
	);
	it.each(["CHAT", "SIMPLE", "TOOL_CALLING"])(
		"allows basic tier for %s",
		(taskType) => {
			expect(
				getAiModelFit({
					taskType,
					suitableForTasks: [taskType],
					capabilities: ["TOOL_CALLING"],
					qualityTier: "BASIC",
				}),
			).toBeNull();
		},
	);
	it.each([10, 12])("adds a cost note at combined price %s", (total) => {
		expect(
			getAiModelFit({
				...rated,
				taskType: "SIMPLE",
				suitableForTasks: ["SIMPLE"],
				inputCostPer1M: 2,
				outputCostPer1M: total - 2,
			}),
		).toEqual({ kind: "cost", reason: "expensive-for-simple" });
	});
	it.each([
		[2, 7.99],
		[0.59, 0.79],
		[null, 12],
		[12, null],
		[undefined, 12],
		[12, undefined],
	])(
		"has no cost note for prices %s / %s",
		(inputCostPer1M, outputCostPer1M) => {
			expect(
				getAiModelFit({
					...rated,
					taskType: "SIMPLE",
					suitableForTasks: ["SIMPLE"],
					qualityTier: "PREMIUM",
					inputCostPer1M,
					outputCostPer1M,
				}),
			).toBeNull();
		},
	);
	it.each([
		"CHAT",
		"COMPLEX",
		"REASONING",
		"TOOL_CALLING",
		"EVAL",
		"EMBEDDING",
		"IMAGE",
		"AUDIO",
		"DECISION",
	])("has no cost note for expensive %s", (taskType) => {
		expect(
			getAiModelFit({
				...rated,
				taskType,
				suitableForTasks: [taskType],
				capabilities: ["TOOL_CALLING"],
				inputCostPer1M: 5,
				outputCostPer1M: 15,
			}),
		).toBeNull();
	});
	it("keeps quality rules ahead of cost", () => {
		const expensive = { ...rated, inputCostPer1M: 5, outputCostPer1M: 15 };
		expect(getAiModelFit({ ...expensive, taskType: "SIMPLE" })).toEqual({
			kind: "quality",
			reason: "not-suitable",
		});
		expect(
			getAiModelFit({ ...expensive, taskType: "TOOL_CALLING" }),
		).toEqual({ kind: "quality", reason: "no-tool-calling" });
		expect(
			getAiModelFit({
				...expensive,
				taskType: "COMPLEX",
				suitableForTasks: ["COMPLEX"],
				qualityTier: "BASIC",
			}),
		).toEqual({ kind: "quality", reason: "basic-tier" });
	});
	it.each(["EMBEDDING", "IMAGE", "AUDIO", "DECISION", "unknown"])(
		"ignores %s",
		(taskType) => {
			expect(
				getAiModelFit({ ...rated, taskType, qualityTier: "BASIC" }),
			).toBeNull();
			expect(
				getAiModelFit({ ...rated, taskType, qualityTier: "PREMIUM" }),
			).toBeNull();
		},
	);
	it.each([undefined, []])(
		"ignores unrated models (%s)",
		(suitableForTasks) => {
			expect(
				getAiModelFit({
					taskType: "TOOL_CALLING",
					suitableForTasks,
					capabilities: [],
					qualityTier: "BASIC",
				}),
			).toBeNull();
			expect(
				getAiModelFit({
					taskType: "SIMPLE",
					suitableForTasks,
					qualityTier: "PREMIUM",
				}),
			).toBeNull();
		},
	);
});
