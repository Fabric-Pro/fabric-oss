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

const MESSAGE_START = {
	type: "custom",
	kind: "anthropic.message_start",
	providerMetadata: {
		anthropic: {
			usage: {
				input_tokens: 100,
				cache_read_input_tokens: 70,
				cache_creation_input_tokens: 20,
				output_tokens: 2,
			},
		},
	},
};

const START_USAGE = {
	inputTokens: 190,
	outputTokens: 2,
	totalTokens: 192,
	inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 20 },
};

describe("Direct chat in-flight step usage", () => {
	it("records measured input when stopped before the first finish-step", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		expect(tracker.partialAggregate()).toMatchObject({
			usage: START_USAGE,
			usageReportedAt: "stream_start",
		});
		// Reading the partial aggregate does not consume or accumulate it.
		expect(tracker.partialAggregate().usage).toMatchObject(START_USAGE);
	});

	it("sums a completed step and a second step stopped after message_start", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addCompletedStep({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		expect(tracker.partialAggregate()).toMatchObject({
			usage: {
				...START_USAGE,
				inputTokens: 200,
				outputTokens: 7,
				totalTokens: 207,
			},
			usageReportedAt: "stream_start",
		});
	});

	it("retains message_start when the SDK finishes an errored step with null usage", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		tracker.addCompletedStep({
			usage: {
				inputTokens: undefined,
				outputTokens: undefined,
				totalTokens: undefined,
				inputTokenDetails: {
					noCacheTokens: undefined,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
				outputTokenDetails: {
					textTokens: undefined,
					reasoningTokens: undefined,
				},
				raw: undefined,
			},
		});
		expect(tracker.partialAggregate()).toMatchObject({
			usage: START_USAGE,
			usageReportedAt: "stream_start",
		});
		tracker.startStep();
		expect(tracker.partialAggregate()).toMatchObject({
			usage: START_USAGE,
			usageReportedAt: "stream_start",
		});
	});

	it("uses explicitly reported zero finish counts instead of stream-start usage", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		tracker.addCompletedStep({
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		});
		expect(tracker.partialAggregate().usage).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});
		expect(tracker.partialAggregate().usageReportedAt).toBeUndefined();
	});

	it("replaces message_start with finish-step usage without double counting", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		expect(tracker.partialAggregate().usage).toMatchObject(START_USAGE);
		tracker.addCompletedStep({
			usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
		});
		expect(tracker.partialAggregate().usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 30,
			totalTokens: 230,
		});
		expect(tracker.partialAggregate().usageReportedAt).toBeUndefined();
	});

	it.each([
		{ ...MESSAGE_START, kind: "example.message_start" },
		{ type: "custom", kind: "anthropic.message_start" },
	])("ignores unrelated or usage-less custom parts: %j", (part) => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		const before = tracker.partialAggregate();
		tracker.addStreamStartUsage(part);
		expect(tracker.partialAggregate()).toEqual(before);
		tracker.startStep();
		tracker.addStreamStartUsage(part);
		expect(tracker.partialAggregate().usage).toBeUndefined();
		expect(tracker.partialAggregate().usageReportedAt).toBeUndefined();
	});

	it("clears step one's stream-start usage when step two starts", () => {
		const tracker = createDirectChatAggregateUsageTracker();
		tracker.startStep();
		tracker.addStreamStartUsage(MESSAGE_START);
		expect(tracker.partialAggregate().usage).toMatchObject(START_USAGE);
		tracker.startStep();
		expect(tracker.partialAggregate().usage).toBeUndefined();
		expect(tracker.partialAggregate().usageReportedAt).toBeUndefined();
	});
});
