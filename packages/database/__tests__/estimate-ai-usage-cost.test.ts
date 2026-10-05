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

	// One contract for every writer (both the AI SDK middleware and the
	// LangChain agent path): `inputTokens` is the provider's TOTAL input,
	// INCLUDING cache reads and writes, and the cache columns are breakdowns of
	// it. AI SDK 7 providers report `inputTokens.total = noCache + cacheRead +
	// cacheWrite`, and `@langchain/anthropic` reports `input_tokens` the same
	// way. Pricing the inclusive total at full rate AND adding cache on top
	// would double-charge every cached token.
	it.each([
		["direct", AIProvider.ANTHROPIC_DIRECT, "claude-sonnet-4-5"],
		["gateway", AIProvider.VERCEL_GATEWAY, "anthropic/claude-sonnet-4.5"],
		["Databricks", AIProvider.DATABRICKS, "databricks-claude-sonnet-4-5"],
	])(
		"Anthropic via %s: 100 inclusive input = 0 uncached + 80 read + 20 write → reads 0.1x, writes 1.25x, nothing at full rate",
		async (_label, provider, providerModelId) => {
			const cost = await estimateAiUsageCostUsd({
				provider,
				providerModelId,
				inputTokens: 100,
				outputTokens: 0,
				cachedInputTokens: 80,
				cacheCreationInputTokens: 20,
			});
			// 0 full-rate + 80*0.1 + 20*1.25 = the cost of 33 full-rate input
			// tokens, not 133 (the double-charge this contract removes).
			near(cost, 80 * 3e-6 * 0.1 + 20 * 3e-6 * 1.25);
			near(cost, 33 * 3e-6);
		},
	);

	it("Anthropic: a cache hit costs less than the same inclusive input uncached", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.ANTHROPIC_DIRECT,
			providerModelId: "anthropic/claude-cache",
			inputTokens: 1000,
			outputTokens: 500,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 100,
		});
		// (1000-800-100)*3e-6 + 800*3e-6*0.1 + 100*3e-6*1.25 + 500*15e-6
		near(cost, 0.0003 + 0.00024 + 0.000375 + 0.0075);
		expect(cost).toBeLessThan(1000 * 3e-6 + 500 * 15e-6);
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
	// surface and reports `prompt_tokens` INCLUSIVE of both cache buckets (live
	// evidence: prompt_tokens 4573 = 4570 cache_creation_input_tokens + 3
	// uncached) — the same inclusive contract every other Anthropic writer now
	// records, so it prices exactly like direct Anthropic.
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

	it("guard: identical tokens price identically for direct-Anthropic and Databricks-Claude", async () => {
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
		near(
			direct,
			(1000 - 800 - 100) * 3e-6 +
				800 * 3e-6 * 0.1 +
				100 * 3e-6 * 1.25 +
				500 * 15e-6,
		);
		near(databricks, direct);
	});

	it("OpenAI via the gateway: unchanged — reads discounted within input, a reported write is not charged", async () => {
		const cost = await estimateAiUsageCostUsd({
			provider: AIProvider.VERCEL_GATEWAY,
			providerModelId: "openai/gpt-5",
			inputTokens: 100,
			outputTokens: 0,
			cachedInputTokens: 80,
			cacheCreationInputTokens: 20,
		});
		// (100-80)*3e-6 + 80*3e-6*0.5; OpenAI has no write charge.
		near(cost, 20 * 3e-6 + 80 * 3e-6 * 0.5);
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
