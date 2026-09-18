import { describe, expect, it } from "vitest";
import { createDirectChatAggregateUsageTracker } from "../aggregate-usage";

describe("Direct chat aggregate usage logging", () => {
	it("retains a completed step's spend when the following step fails", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();

		tracker.addCompletedStep({
			usage: {
				inputTokens: 120,
				outputTokens: 40,
				totalTokens: 160,
				inputTokenDetails: {
					cacheReadTokens: 70,
					cacheWriteTokens: 20,
				},
				outputTokenDetails: { reasoningTokens: 10 },
			},
			providerMetadata: { gateway: { generationId: "gen_completed" } },
		});
		tracker.startStep();

		// The next provider step fails before it can emit finish-step. The caller
		// must write this partial aggregate as its one failure row.
		expect(tracker.partialAggregate()).toEqual({
			usage: {
				inputTokens: 120,
				outputTokens: 40,
				totalTokens: 160,
				inputTokenDetails: {
					cacheReadTokens: 70,
					cacheWriteTokens: 20,
				},
				outputTokenDetails: { reasoningTokens: 10 },
			},
			steps: [
				{
					providerMetadata: {
						gateway: { generationId: "gen_completed" },
					},
				},
				{},
			],
		});
	});

	it("sums completed steps before a later failure", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.addCompletedStep({
			usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
		});
		tracker.addCompletedStep({
			usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
		});

		expect(tracker.partialAggregate().usage).toMatchObject({
			inputTokens: 150,
			outputTokens: 50,
			totalTokens: 200,
		});
	});
});
