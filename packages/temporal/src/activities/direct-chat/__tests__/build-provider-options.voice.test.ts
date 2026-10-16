import type { AIProvider } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	buildProviderOptions,
	getMaxOutputTokensForProviderOptions,
} from "../build-provider-options";

describe("buildProviderOptions for a spoken turn", () => {
	it.each([
		["VERCEL_GATEWAY", "openai/gpt-6-luna", "low"],
		["OPENAI_DIRECT", "gpt-6-luna", "low"],
		["VERCEL_GATEWAY", "openai/gpt-5.5", "low"],
		["VERCEL_GATEWAY", "openai/o3", "low"],
		["OPENAI_DIRECT", "gpt-5-mini", "minimal"],
		["VERCEL_GATEWAY", "openai/gpt-5", "minimal"],
	] as [AIProvider, string, string][])(
		"%s + %s carries reasoning effort %s",
		(provider, model, effort) => {
			expect(
				buildProviderOptions(provider, model, "balanced", "parlume"),
			).toEqual({ openai: { reasoningEffort: effort } });
		},
	);

	it("is the same whatever reasoning mode the agent saved", () => {
		for (const mode of ["lite", "balanced", "pro", undefined] as const) {
			expect(
				buildProviderOptions(
					"VERCEL_GATEWAY",
					"openai/gpt-6-luna",
					mode,
					"parlume",
				),
			).toEqual({ openai: { reasoningEffort: "low" } });
		}
	});

	it("never enables Anthropic thinking, even in pro mode", () => {
		expect(
			buildProviderOptions(
				"ANTHROPIC_DIRECT",
				"claude-sonnet-5",
				"pro",
				"parlume",
			),
		).toBeUndefined();
		expect(
			buildProviderOptions(
				"VERCEL_GATEWAY",
				"anthropic/claude-3-7-sonnet",
				"pro",
				"parlume",
			),
		).toBeUndefined();
	});

	it.each([
		["VERCEL_GATEWAY", "openai/gpt-4.1"],
		["VERCEL_GATEWAY", "openai/gpt-5-chat-latest"],
		["OPENAI_DIRECT", "gpt-4o"],
		["OPENROUTER", "openai/gpt-6-luna"],
		["AZURE_AI_FOUNDRY", "gpt-6-luna"],
		["GROQ", "openai/gpt-oss-120b"],
	] as [AIProvider, string][])(
		"%s + %s is not asked for a reasoning effort it may reject",
		(provider, model) => {
			expect(
				buildProviderOptions(provider, model, "balanced", "parlume"),
			).toBeUndefined();
		},
	);

	it.each([undefined, "chat-agent", "fabric-agent"])(
		"a turn with feature key %s carries no reasoning effort",
		(featureKey) => {
			expect(
				buildProviderOptions(
					"VERCEL_GATEWAY",
					"openai/gpt-6-luna",
					"balanced",
					featureKey,
				),
			).toBeUndefined();
		},
	);

	it("leaves a non-voice turn's Anthropic thinking as it was", () => {
		expect(
			buildProviderOptions(
				"ANTHROPIC_DIRECT",
				"claude-3-7-sonnet-20250219",
				"pro",
				"chat-agent",
			),
		).toEqual({
			anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } },
		});
	});

	it("does not add a thinking floor to the output budget", () => {
		const opts = buildProviderOptions(
			"VERCEL_GATEWAY",
			"openai/gpt-6-luna",
			"pro",
			"parlume",
		);
		expect(getMaxOutputTokensForProviderOptions(opts)).toBeUndefined();
	});
});
