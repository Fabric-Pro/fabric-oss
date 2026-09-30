import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { runLLMMetrics } from "../mastra-llm-metrics";

function modelResult(output: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(output) }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage: {
			inputTokens: {
				total: 10,
				noCache: 10,
				cacheRead: 0,
				cacheWrite: 0,
			},
			outputTokens: { total: 10, text: 10, reasoning: 0 },
		},
		warnings: [],
	};
}

describe("runLLMMetrics", () => {
	it("evaluates all metrics with an AI SDK v4 model", async () => {
		const onUsageTracked = vi.fn();
		const model = new MockLanguageModelV4({
			doGenerate: [
				modelResult({
					score: 90,
					reasoning: "Clear and complete.",
					strengths: ["Clear"],
					weaknesses: ["Could add detail"],
				}),
				modelResult({
					score: 80,
					reasoning: "Flows logically.",
					issues: ["One abrupt transition"],
				}),
				modelResult({
					score: 70,
					reasoning: "Covers the main request.",
					addressedRequirements: ["Requirements"],
					missedRequirements: ["Examples"],
				}),
			],
		});

		const result = await runLLMMetrics({
			documentContent: "# Overview\nA complete document.",
			documentType: "general",
			expectedSections: ["Overview"],
			userPrompt: "Describe the project requirements.",
			provider: "OPENAI_DIRECT",
			model: "mock-model",
			languageModel: model,
			onUsageTracked,
		});

		expect(result).toMatchObject({
			quality: {
				score: 79,
				reasoning: "Clear and complete.",
				details: { weaknesses: ["Could add detail"] },
			},
			coherence: {
				score: 74,
				reasoning: "Flows logically.",
				details: { issues: ["One abrupt transition"] },
			},
			alignment: {
				score: 67,
				reasoning: "Covers the main request.",
				details: { missedRequirements: ["Examples"] },
			},
			overallScore: 73,
		});
		expect(model.doGenerateCalls).toHaveLength(3);
		expect(
			model.doGenerateCalls.every((call) => !("temperature" in call)),
		).toBe(true);
		expect(onUsageTracked).toHaveBeenCalledOnce();
	});

	it("skips alignment when no user prompt is available", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				modelResult({ score: 80, reasoning: "Good.", strengths: [] }),
				modelResult({
					score: 70,
					reasoning: "Mostly coherent.",
					issues: [],
				}),
			],
		});

		const result = await runLLMMetrics({
			documentContent: "# Overview",
			documentType: "general",
			expectedSections: ["Overview"],
			provider: "OPENAI_DIRECT",
			model: "mock-model",
			languageModel: model,
		});

		expect(result.alignment).toBeNull();
		expect(model.doGenerateCalls).toHaveLength(2);
	});

	it("keeps completed metrics when one structured generation fails", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				modelResult({ score: 80, reasoning: "Good.", strengths: [] }),
				new Error("coherence unavailable"),
				modelResult({
					score: 70,
					reasoning: "Addresses the request.",
					addressedRequirements: [],
				}),
			],
		});

		const result = await runLLMMetrics({
			documentContent: "# Overview",
			documentType: "general",
			expectedSections: ["Overview"],
			userPrompt: "Describe the project.",
			provider: "OPENAI_DIRECT",
			model: "mock-model",
			languageModel: model,
		});

		expect(result).toMatchObject({
			quality: { score: 72, reasoning: "Good." },
			coherence: null,
			alignment: { score: 67, reasoning: "Addresses the request." },
			overallScore: 70,
		});
	});

	it("bounds document prompts and clears the activity heartbeat", async () => {
		const clearIntervalSpy = vi.spyOn(global, "clearInterval");
		const model = new MockLanguageModelV4({
			doGenerate: [
				modelResult({ score: 80, reasoning: "Good.", strengths: [] }),
				modelResult({
					score: 70,
					reasoning: "Mostly coherent.",
					issues: [],
				}),
			],
		});
		const documentContent = `${"a".repeat(8000)}MUST_NOT_BE_PROMPTED`;

		await runLLMMetrics({
			documentContent,
			documentType: "general",
			expectedSections: ["Overview"],
			provider: "OPENAI_DIRECT",
			model: "mock-model",
			languageModel: model,
		});

		const prompts = JSON.stringify(model.doGenerateCalls);
		expect(prompts).toContain("a".repeat(8000));
		expect(prompts).not.toContain("MUST_NOT_BE_PROMPTED");
		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
	});
});
