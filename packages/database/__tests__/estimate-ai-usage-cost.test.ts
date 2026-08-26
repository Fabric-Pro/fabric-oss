/**
 * Cache-aware cost formula (estimateAiUsageCostUsd). Fixed catalog rate of
 * $3 / 1M input, $15 / 1M output; asserts the per-model-family prompt-cache
 * pricing and backward-compatibility when no cache tokens are present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIProvider } from "../prisma/generated/client";

const findFirst = vi.fn();
vi.mock("../prisma/client", () => ({
	Prisma: { Decimal: class {} },
	db: {
		aiModelProviderMapping: { findFirst },
		aiModel: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

const { estimateAiUsageCostUsd } = await import("../prisma/queries/ai-credits");

const RATE = {
	inputCostPer1M: 3,
	outputCostPer1M: 15,
	model: { inputCostPer1M: 3, outputCostPer1M: 15 },
};
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe("estimateAiUsageCostUsd — cache-aware pricing", () => {
	beforeEach(() => {
		findFirst.mockReset();
		findFirst.mockResolvedValue(RATE);
	});

	it("no cache tokens → input*rate + output*rate (backward-compatible)", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.ANTHROPIC_DIRECT,
			providerModelId: "anthropic/claude-nocache",
			inputTokens: 1000,
			outputTokens: 500,
		});
		// 1000*3e-6 + 500*15e-6
		near(cost, 0.003 + 0.0075);
	});

	it("Anthropic: cache reads added at 0.1x, writes at 1.25x, on top of input", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.ANTHROPIC_DIRECT,
			providerModelId: "anthropic/claude-cache",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 200,
		});
		// 1000*3e-6 + 800*3e-6*0.1 + 200*3e-6*1.25 + 500*15e-6
		near(cost, 0.003 + 0.00024 + 0.00075 + 0.0075);
	});

	it("OpenAI: cached reads are within inputTokens, discounted to 0.5x", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.OPENAI_DIRECT,
			providerModelId: "openai/gpt-4o-cache",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
		});
		// (1000-800)*3e-6 + 800*3e-6*0.5 + 500*15e-6
		near(cost, 0.0006 + 0.0012 + 0.0075);
	});

	it("unknown family with cache tokens → charges all input at 1x (no guess)", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.OPENAI_DIRECT,
			providerModelId: "mistral/large-cache",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
		});
		// cache ignored → 1000*3e-6 + 500*15e-6 (same as no-cache)
		near(cost, 0.003 + 0.0075);
	});

	it("unpriced model → $0 (no pricing row)", async () => {
		findFirst.mockResolvedValue(null);
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.OPENAI_DIRECT,
			providerModelId: "unknown/model-unpriced",
			inputTokens: 1000,
			outputTokens: 500,
		});
		expect(cost).toBe(0);
	});

	// Databricks Foundation Model API serves Claude behind an OpenAI-compatible
	// surface: same Anthropic 0.1x/1.25x cache multipliers, but `prompt_tokens`
	// is reported INCLUSIVE of BOTH the cache-read AND the cache-write portion
	// (live evidence: prompt_tokens 4573 = 4570 cache_creation_input_tokens + 3
	// uncached), unlike direct/Bedrock/Vertex Anthropic where both are reported
	// separately from inputTokens. Charging it like direct Anthropic (both
	// added on top of the full, un-discounted inputTokens) double-counts both:
	// a cache HIT would cost MORE than an uncached call, and a cache-WRITE call
	// would bill its write tokens at input-rate PLUS the write multiplier.
	it("Databricks Claude: both reads and writes are subsets of inclusive inputTokens", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.DATABRICKS,
			providerModelId: "databricks-claude-haiku-4-5",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 100,
		});
		// Only 1000 - 800 (read) - 100 (write) = 100 tokens remain at full rate.
		// 100*3e-6 + 800*3e-6*0.1 + 100*3e-6*1.25 + 500*15e-6
		near(cost, 0.0003 + 0.00024 + 0.000375 + 0.0075);
		// The read discount must LOWER the estimate below the naive
		// inputTokens*rate figure — a cache hit is cheaper, never pricier.
		expect(cost).toBeLessThan(1000 * 3e-6 + 500 * 15e-6);
	});

	it("Databricks Claude, cache-write-only call: the write tokens are also a subset of inputTokens, not additional to it", async () => {
		// A first-turn cache-write call: no reads yet, all of the cached prefix
		// is being written. Would previously bill the write tokens twice — once
		// inside the un-discounted inputTokens, once again at the 1.25x write
		// multiplier — exactly the double-charge this fix removes.
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.DATABRICKS,
			providerModelId: "databricks-claude-haiku-4-5",
			inputTokens: 1000,
			outputTokens: 500,
			cacheCreationInputTokens: 900,
		});
		// 1000 - 0 (read) - 900 (write) = 100 tokens remain at full rate.
		// 100*3e-6 + 900*3e-6*1.25 + 500*15e-6
		near(cost, 0.0003 + 0.003375 + 0.0075);
	});

	it("guard: identical tokens diverge between direct-Anthropic (exclusive) and Databricks-Claude (inclusive) accounting", async () => {
		const shared = {
			providerModelId: "claude-sonnet-5",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 100,
		};
		const direct = await estimateAiUsageCostUsd({
			provider: AIProvider.ANTHROPIC_DIRECT,
			...shared,
		});
		const databricks = await estimateAiUsageCostUsd({
			provider: AIProvider.DATABRICKS,
			...shared,
		});
		// Direct Anthropic: reads/writes ADDED on top of the full inputTokens.
		near(
			direct,
			1000 * 3e-6 + 800 * 3e-6 * 0.1 + 100 * 3e-6 * 1.25 + 500 * 15e-6,
		);
		// Databricks: reads AND writes DISCOUNTED within the already-inclusive
		// inputTokens — only 1000 - 800 - 100 = 100 tokens at full rate.
		near(
			databricks,
			(1000 - 800 - 100) * 3e-6 +
				800 * 3e-6 * 0.1 +
				100 * 3e-6 * 1.25 +
				500 * 15e-6,
		);
		expect(databricks).toBeLessThan(direct);
	});

	it("Databricks non-Claude model keeps the unknown-family fallback (no Anthropic multipliers)", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.DATABRICKS,
			providerModelId: "databricks-dbrx-instruct",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
		});
		// id has no claude/anthropic marker → falls through to the unknown-family
		// branch, cache ignored — same as the generic "unknown family" case.
		near(cost, 0.003 + 0.0075);
	});
});
