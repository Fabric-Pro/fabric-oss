import { beforeEach, describe, expect, it, vi } from "vitest";

const usageGroupBy = vi.hoisted(() => vi.fn());
const outcomeGroupBy = vi.hoisted(() => vi.fn());
const promptVersionFindMany = vi.hoisted(() => vi.fn());
const modelDefaultFindMany = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: {
		aiUsageLog: { groupBy: usageGroupBy },
		aiOutcomeEvent: { groupBy: outcomeGroupBy },
		promptVersion: { findMany: promptVersionFindMany },
		aiTaskModelDefault: { findMany: modelDefaultFindMany },
	},
	Prisma: {},
}));

import {
	AI_EMBEDDINGS_FEATURE_KEY,
	getAiChangeAnnotations,
	getAiOutcomeSegments,
	getAiUsageByFeature,
} from "../ai-adoption-segmentation";

const RANGE = { from: new Date("2026-08-01"), to: new Date("2026-08-19") };

describe("getAiUsageByFeature", () => {
	beforeEach(() => usageGroupBy.mockReset());

	it("folds success and failure rows into one entry per feature", async () => {
		usageGroupBy.mockResolvedValue([
			{
				featureKey: "maturation",
				taskType: "COMPLEX",
				success: true,
				_count: { _all: 8 },
				_sum: { totalTokens: 800, costMicroUsd: 8000 },
			},
			{
				featureKey: "maturation",
				taskType: "COMPLEX",
				success: false,
				_count: { _all: 2 },
				_sum: { totalTokens: 100, costMicroUsd: 1000 },
			},
		]);

		const [row] = await getAiUsageByFeature(RANGE);
		expect(row).toMatchObject({
			featureKey: "maturation",
			requests: 10,
			failedRequests: 2,
			totalTokens: 900,
			costMicroUsd: 9000,
		});
	});

	/**
	 * Dropping the null bucket would make tagged features look like the whole
	 * picture while tag coverage is still growing — the exact misreading the
	 * UI copy warns about.
	 */
	it("keeps the untagged bucket rather than hiding it", async () => {
		usageGroupBy.mockResolvedValue([
			{
				featureKey: null,
				taskType: "SIMPLE",
				success: true,
				_count: { _all: 40 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
			{
				featureKey: "chat-agent",
				taskType: "CHAT",
				success: true,
				_count: { _all: 5 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
		]);

		const rows = await getAiUsageByFeature(RANGE);
		expect(rows.map((r) => r.featureKey)).toEqual([null, "chat-agent"]);
	});

	/**
	 * Embeddings resolve through a path that cannot carry a feature key and are
	 * usually most of the rows, so folding them into null would report the bulk
	 * of traffic as a tagging gap that nobody can ever close.
	 */
	it("separates embeddings from genuinely untagged language-model calls", async () => {
		usageGroupBy.mockResolvedValue([
			{
				featureKey: null,
				taskType: "EMBEDDING",
				success: true,
				_count: { _all: 399 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
			{
				featureKey: null,
				taskType: "SIMPLE",
				success: true,
				_count: { _all: 7 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
		]);

		const rows = await getAiUsageByFeature(RANGE);
		expect(rows.map((r) => r.featureKey)).toEqual([
			AI_EMBEDDINGS_FEATURE_KEY,
			null,
		]);
		expect(rows[0].requests).toBe(399);
		expect(rows[1].requests).toBe(7);
	});

	it("returns busiest feature first", async () => {
		usageGroupBy.mockResolvedValue([
			{
				featureKey: "a",
				taskType: "SIMPLE",
				success: true,
				_count: { _all: 1 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
			{
				featureKey: "b",
				taskType: "SIMPLE",
				success: true,
				_count: { _all: 9 },
				_sum: { totalTokens: 0, costMicroUsd: 0 },
			},
		]);
		const rows = await getAiUsageByFeature(RANGE);
		expect(rows[0].featureKey).toBe("b");
	});
});

describe("getAiOutcomeSegments", () => {
	beforeEach(() => outcomeGroupBy.mockReset());

	it("groups by model and prompt version, not by today's binding", async () => {
		outcomeGroupBy.mockResolvedValue([
			{
				modelCanonicalName: "claude-sonnet-5",
				promptVersionId: "pv-1",
				featureKey: "maturation",
				outcome: "ACCEPTED_AS_IS",
				_count: { _all: 6 },
			},
			{
				modelCanonicalName: "claude-sonnet-5",
				promptVersionId: "pv-2",
				featureKey: "maturation",
				outcome: "REJECTED",
				_count: { _all: 4 },
			},
		]);

		const segments = await getAiOutcomeSegments(RANGE);
		expect(segments).toHaveLength(2);
		expect(outcomeGroupBy.mock.calls[0][0].by).toEqual([
			"modelCanonicalName",
			"promptVersionId",
			"featureKey",
			"outcome",
		]);
	});

	/**
	 * An edit still means the AI did the work; counting it as a failure would
	 * understate a feature that saves effort without producing final copy.
	 */
	it("counts an edit as acceptance", async () => {
		outcomeGroupBy.mockResolvedValue([
			{
				modelCanonicalName: "m",
				promptVersionId: null,
				featureKey: "f",
				outcome: "ACCEPTED_WITH_EDITS",
				_count: { _all: 3 },
			},
			{
				modelCanonicalName: "m",
				promptVersionId: null,
				featureKey: "f",
				outcome: "REJECTED",
				_count: { _all: 1 },
			},
		]);

		const [segment] = await getAiOutcomeSegments(RANGE);
		expect(segment.total).toBe(4);
		expect(segment.acceptanceRate).toBe(75);
	});

	it("zero-fills unseen outcomes so a rate cannot come out NaN", async () => {
		outcomeGroupBy.mockResolvedValue([
			{
				modelCanonicalName: null,
				promptVersionId: null,
				featureKey: "f",
				outcome: "RATED_UP",
				_count: { _all: 2 },
			},
		]);
		const [segment] = await getAiOutcomeSegments(RANGE);
		expect(segment.counts.REJECTED).toBe(0);
		expect(segment.acceptanceRate).toBe(100);
	});
});

describe("getAiChangeAnnotations", () => {
	beforeEach(() => {
		promptVersionFindMany.mockReset().mockResolvedValue([]);
		modelDefaultFindMany.mockReset().mockResolvedValue([]);
	});

	it("merges prompt and model changes into one date-sorted timeline", async () => {
		promptVersionFindMany.mockResolvedValue([
			{
				version: 4,
				createdAt: new Date("2026-08-12T10:00:00Z"),
				changeNote: "tightened the rubric",
				prompt: { key: "feature_clean_spec_generator" },
			},
		]);
		modelDefaultFindMany.mockResolvedValue([
			{
				taskType: "COMPLEX",
				complexity: "HIGH",
				updatedAt: new Date("2026-08-05T09:00:00Z"),
				model: { canonicalName: "claude-sonnet-5" },
			},
		]);

		const annotations = await getAiChangeAnnotations(RANGE);
		expect(annotations.map((a) => a.date)).toEqual([
			"2026-08-05",
			"2026-08-12",
		]);
		expect(annotations[0]).toMatchObject({
			kind: "MODEL_DEFAULT",
			label: "COMPLEX/HIGH → claude-sonnet-5",
		});
		expect(annotations[1]).toMatchObject({
			kind: "PROMPT_VERSION",
			label: "feature_clean_spec_generator v4",
			detail: "tightened the rubric",
		});
	});

	it("returns an empty timeline when nothing changed", async () => {
		expect(await getAiChangeAnnotations(RANGE)).toEqual([]);
	});
});
