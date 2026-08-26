import type { BudgetMetadata } from "@repo/ai/lib/output-token-budget";
import type { AIProvider } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_THINKING_MIN_MAX_TOKENS,
	buildProviderOptions,
	DIRECT_CHAT_OUTPUT_TOKEN_CEILING,
	getMaxOutputTokensForProviderOptions,
	isAnthropicProvider,
	resolveOutputTokenBudget,
} from "../build-provider-options";

describe("isAnthropicProvider", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-3-7-sonnet", true],
		["VERCEL_GATEWAY", "claude-3-7-sonnet", true],
		["VERCEL_GATEWAY", "anthropic/claude-3-7-sonnet", true],
		["VERCEL_GATEWAY", "gpt-4o", false],
		["OPENAI_DIRECT", "gpt-4o", false],
		["GROQ", "deepseek-r1-distill-llama-70b", false],
		["DEEPSEEK", "deepseek-reasoner", false],
		["TOGETHER_AI", "deepseek-r1", false],
		["AWS_BEDROCK", "anthropic.claude-3-7-sonnet", false], // Bedrock uses its own API; no Anthropic thinking toggle here
		["AZURE_AI_FOUNDRY", "claude-3-7-sonnet", false], // Azure Foundry routes via OpenAI-compat; no thinking toggle
	] as [AIProvider, string, boolean][])(
		"isAnthropicProvider(%s, %s) → %s",
		(provider, modelString, expected) => {
			expect(isAnthropicProvider(provider, modelString)).toBe(expected);
		},
	);
});

describe("buildProviderOptions", () => {
	it("enables Anthropic extended thinking for ANTHROPIC_DIRECT in pro mode", () => {
		const opts = buildProviderOptions(
			"ANTHROPIC_DIRECT",
			"claude-3-7-sonnet-20250219",
			"pro",
		);
		expect(opts).toEqual({
			anthropic: {
				thinking: { type: "enabled", budgetTokens: 5000 },
			},
		});
	});

	it("enables Anthropic extended thinking for VERCEL_GATEWAY claude in pro mode", () => {
		const opts = buildProviderOptions(
			"VERCEL_GATEWAY",
			"claude-3-7-sonnet-20250219",
			"pro",
		);
		expect(opts).toEqual({
			anthropic: {
				thinking: { type: "enabled", budgetTokens: 5000 },
			},
		});
	});

	it("returns undefined for VERCEL_GATEWAY with a non-claude model in pro mode", () => {
		expect(
			buildProviderOptions("VERCEL_GATEWAY", "gpt-4o", "pro"),
		).toBeUndefined();
	});

	it("returns undefined for all non-Anthropic direct providers in pro mode", () => {
		// Subset of AIProvider enum verified against packages/database/prisma/schema.prisma
		const nonAnthropicProviders: AIProvider[] = [
			"OPENAI_DIRECT",
			"GROQ",
			"DEEPSEEK",
			"TOGETHER_AI",
			"CEREBRAS",
			"MISTRAL_AI",
			"FIREWORKS",
			"COHERE",
			"AZURE_AI_FOUNDRY",
			"AWS_BEDROCK",
			"GOOGLE_VERTEX_AI",
			"AZURE_OPENAI",
			"CLOUDFLARE_AI",
		];
		for (const provider of nonAnthropicProviders) {
			expect(
				buildProviderOptions(provider, "gpt-4o", "pro"),
				`expected undefined for ${provider}`,
			).toBeUndefined();
		}
	});

	// NEW Codex P2 tests — mode gating

	it.each([
		["lite", "ANTHROPIC_DIRECT", "claude-3-7-sonnet-20250219"],
		["balanced", "ANTHROPIC_DIRECT", "claude-3-7-sonnet-20250219"],
		["lite", "VERCEL_GATEWAY", "claude-3-7-sonnet-20250219"],
		["balanced", "VERCEL_GATEWAY", "claude-3-7-sonnet-20250219"],
	] as const)(
		"does NOT enable thinking for %s mode even with Anthropic provider %s + %s (Codex P2)",
		(mode, provider, modelString) => {
			// Without this gate, users on lite/balanced silently paid +5k thinking
			// tokens whenever their resolved model happened to be Claude.
			expect(
				buildProviderOptions(provider as AIProvider, modelString, mode),
			).toBeUndefined();
		},
	);

	it("returns undefined when reasoningMode is undefined (defense in depth)", () => {
		expect(
			buildProviderOptions(
				"ANTHROPIC_DIRECT",
				"claude-3-7-sonnet-20250219",
				undefined,
			),
		).toBeUndefined();
	});
});

describe("getMaxOutputTokensForProviderOptions — Anthropic max_tokens pairing", () => {
	// Why these tests matter:
	// Anthropic enforces `thinking.budget_tokens < max_tokens` strictly.
	// The AI SDK default max_tokens for Claude (4096) is BELOW the thinking
	// budget (5000) we set in buildProviderOptions, so submitting them
	// together without an explicit max_tokens override returns HTTP 400.
	// PR #1093 hit exactly this — the launcher's reasoningMode="deep"
	// enabled thinking but didn't pass max_tokens, breaking the whole
	// executeDirectChatActivity. PR #1098 reverted to "balanced" as a
	// hotfix. This helper is the proper fix and must stay paired with
	// buildProviderOptions at every call site.

	it("returns the documented minimum max_tokens when providerOptions enables thinking", () => {
		const providerOptions = buildProviderOptions(
			"ANTHROPIC_DIRECT",
			"claude-3-7-sonnet-20250219",
			"pro",
		);
		expect(providerOptions).toBeDefined(); // sanity
		const maxOutputTokens =
			getMaxOutputTokensForProviderOptions(providerOptions);
		expect(maxOutputTokens).toBe(ANTHROPIC_THINKING_MIN_MAX_TOKENS);
	});

	it("max_tokens is strictly greater than the thinking budget (Anthropic API constraint)", () => {
		const providerOptions = buildProviderOptions(
			"ANTHROPIC_DIRECT",
			"claude-3-7-sonnet-20250219",
			"pro",
		);
		const maxOutputTokens =
			getMaxOutputTokensForProviderOptions(providerOptions);
		const thinkingBudget =
			providerOptions?.anthropic?.thinking?.budgetTokens ?? Number.NaN;
		expect(Number.isFinite(thinkingBudget)).toBe(true);
		expect(maxOutputTokens).toBeDefined();
		expect(maxOutputTokens as number).toBeGreaterThan(thinkingBudget);
		// Buffer must be meaningful — Anthropic needs room for the actual
		// reply on top of the thinking budget. Anything ≤ 1024 above the
		// budget is too tight for tool-calling output.
		expect((maxOutputTokens as number) - thinkingBudget).toBeGreaterThan(
			1024,
		);
	});

	it("returns undefined when no providerOptions are set (lite/balanced modes)", () => {
		expect(getMaxOutputTokensForProviderOptions(undefined)).toBeUndefined();
	});

	it("returns undefined when providerOptions exists but thinking is absent", () => {
		// Defensive shape — a future provider extension might pass non-thinking
		// providerOptions. The helper must not over-restrict max_tokens for those.
		expect(
			getMaxOutputTokensForProviderOptions({
				anthropic: { thinking: undefined as never },
			} as never),
		).toBeUndefined();
	});

	it("end-to-end: balanced + Anthropic → no provider opts, no max_tokens override", () => {
		// The lite/balanced cost-guard path verified together with the
		// max_tokens helper, so a future change that accidentally enables
		// thinking on balanced wouldn't silently force the higher
		// max_tokens too.
		const providerOptions = buildProviderOptions(
			"ANTHROPIC_DIRECT",
			"claude-3-7-sonnet-20250219",
			"balanced",
		);
		expect(providerOptions).toBeUndefined();
		expect(
			getMaxOutputTokensForProviderOptions(providerOptions),
		).toBeUndefined();
	});
});

describe("resolveOutputTokenBudget", () => {
	// Databricks injects max_tokens 8,192 and @ai-sdk/anthropic falls back to
	// 4,096 when a request omits the field, so a Direct chat turn that sent
	// nothing had its long answers cut off mid-sentence with no error. Only
	// `pro` mode ever sent a value, and `pro` is not the default.
	const databricks: BudgetMetadata = { provider: "DATABRICKS" };

	it("sends an explicit budget when thinking is off", () => {
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: databricks,
			promptChars: 4_000,
		});

		expect(budget).toBe(DIRECT_CHAT_OUTPUT_TOKEN_CEILING);
	});

	it("clears both providers' silent defaults", () => {
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: databricks,
			promptChars: 4_000,
		});

		expect(budget).toBeGreaterThan(8_192);
	});

	it("lets the thinking floor win so the #1098 HTTP 400 cannot return", () => {
		// Routing this through the budget helper's context clamp could drop
		// it below thinking.budget_tokens, which Anthropic rejects outright.
		const providerOptions = buildProviderOptions(
			"ANTHROPIC_DIRECT",
			"claude-sonnet-4",
			"pro",
		);

		const budget = resolveOutputTokenBudget({
			providerOptions,
			metadata: { provider: "ANTHROPIC_DIRECT", contextWindow: 20_000 },
			promptChars: 60_000,
		});

		expect(budget).toBe(ANTHROPIC_THINKING_MIN_MAX_TOKENS);
	});

	it("leaves providers that need no workaround alone", () => {
		// No catalog cap and no silent substitution — omitting the field is
		// correct, and asking for a budget would reserve quota for nothing.
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: { provider: "GROQ" },
			promptChars: 4_000,
		});

		expect(budget).toBeUndefined();
	});

	it("still omits the field when an unaffected provider has a catalog cap", () => {
		// Regression guard. `computeMaxOutputTokenBudget` returns a number for
		// ANY provider carrying `maxOutputTokens` — its own provider gate only
		// picks the FALLBACK cap — so calling it unconditionally here would
		// have started sending `max_tokens` on providers that never truncated,
		// reserving TPM/OTPM quota for output that was never coming. The first
		// version of this change did exactly that, and the test above missed
		// it because its metadata carried no cap.
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: { provider: "GROQ", maxOutputTokens: 8_000 },
			promptChars: 4_000,
		});

		expect(budget).toBeUndefined();
	});

	it("respects an affected provider's catalog cap below the ceiling", () => {
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: { provider: "DATABRICKS", maxOutputTokens: 8_000 },
			promptChars: 4_000,
		});

		expect(budget).toBe(8_000);
	});

	it("reserves room for the prompt inside the context window", () => {
		const budget = resolveOutputTokenBudget({
			providerOptions: undefined,
			metadata: { provider: "DATABRICKS", contextWindow: 20_000 },
			promptChars: 30_000,
		});

		expect(budget).toBeLessThan(DIRECT_CHAT_OUTPUT_TOKEN_CEILING);
	});
});
