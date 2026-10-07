/**
 * The API-equivalent estimate of ChatGPT plan usage (Fizzy #2939): plan tokens
 * priced at the catalog price of each plan model's reference API model, with
 * the real catalog cost formula. The plan rows' own cost is never touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());

vi.mock("@repo/database/prisma/client", () => ({
	db: { aiModelProviderMapping: { findFirst } },
}));

vi.mock("@repo/database", async () => ({
	estimateAiUsageCostUsd: (
		await vi.importActual<
			typeof import("@repo/database/prisma/queries/ai-credits")
		>("@repo/database/prisma/queries/ai-credits")
	).estimateAiUsageCostUsd,
}));

const { estimateChatGptPlanApiCost } = await import("../chatgpt-plan-cost");

beforeEach(() => {
	findFirst.mockReset();
	// gpt-6-astra on the API: $10 / 1M input, $50 / 1M output.
	findFirst.mockImplementation(
		async ({ where }: { where: { providerModelId: string } }) =>
			where.providerModelId === "gpt-6-astra"
				? {
						inputCostPer1M: null,
						outputCostPer1M: null,
						model: { inputCostPer1M: 10, outputCostPer1M: 50 },
					}
				: null,
	);
});

describe("estimateChatGptPlanApiCost", () => {
	it("prices plan tokens as the reference API model", async () => {
		const usage = {
			providerModelId: "gpt-6-astra",
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedInputTokens: 0,
		};
		const estimate = await estimateChatGptPlanApiCost([usage]);
		// 1M × $10/1M + 100k × $50/1M = $15.
		expect(estimate).toEqual({
			estimatedApiCostMicroUsd: 15_000_000,
			referenceModels: ["gpt-6-astra"],
		});
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					provider: "OPENAI_DIRECT",
					providerModelId: "gpt-6-astra",
				}),
			}),
		);
		// The usage passed in is not modified; plan rows keep their 0 cost.
		expect(usage).toEqual({
			providerModelId: "gpt-6-astra",
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedInputTokens: 0,
		});
	});

	it("estimates nothing when there is no plan usage", async () => {
		await expect(estimateChatGptPlanApiCost([])).resolves.toEqual({
			estimatedApiCostMicroUsd: 0,
			referenceModels: [],
		});
	});
});
