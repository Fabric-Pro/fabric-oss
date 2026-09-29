/**
 * Truth tables for the shared Anthropic request-constraint predicates in
 * `@repo/agent-types`. Both the LangChain factory in this package and the
 * Temporal direct-chat / orchestrator activities key their request shaping
 * on these two predicates, so a drift here is a drift on every path.
 *
 * Model strings reach those paths in many spellings — bare, Vercel gateway
 * (`anthropic/`, dotted versions), Bedrock (`anthropic.`), Databricks
 * (`system.ai.`, `databricks-`), and dated suffixes — so every positive is
 * checked in each spelling, and the near-miss negatives are pinned.
 */
import {
	anthropicModelRejectsForcedToolChoice,
	isAnthropicAdaptiveOnlyModel,
} from "@repo/agent-types";
import { describe, expect, it } from "vitest";

/** Every routing spelling a bare dashed Anthropic id can arrive in. */
function spellings(bare: string): string[] {
	const dotted = bare.replace(/-(\d+)-(\d+)$/, "-$1.$2");
	return [
		bare,
		`anthropic/${bare}`,
		`anthropic/${dotted}`,
		`anthropic.${bare}`,
		`us.anthropic.${bare}`,
		`system.ai.${bare}`,
		`databricks-${bare}`,
		`${bare}-20260901`,
		bare.toUpperCase(),
	];
}

describe("isAnthropicAdaptiveOnlyModel", () => {
	const adaptiveOnly = [
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-opus-5-5",
		"claude-sonnet-5",
		"claude-sonnet-5-5",
		"claude-fable-5",
		"claude-fable-5-1",
		"claude-mythos-5",
		"claude-mythos-5-1",
	];
	for (const bare of adaptiveOnly) {
		it.each(spellings(bare))(`${bare}: %s → true`, (model) => {
			expect(isAnthropicAdaptiveOnlyModel(model)).toBe(true);
		});
	}

	it("matches the vendored LangChain adaptive-only preview id", () => {
		expect(isAnthropicAdaptiveOnlyModel("claude-mythos-preview")).toBe(
			true,
		);
	});

	it.each([
		"claude-opus-4-6",
		"anthropic/claude-opus-4.6",
		"claude-sonnet-4-6",
		"anthropic/claude-sonnet-4.6",
		"system.ai.claude-sonnet-4-5",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
		"claude-opus-4-1",
		"claude-opus-4",
		"claude-3-7-sonnet",
		"claude-opus-4-70",
		"claude-sonnet-50",
		"gpt-5.5",
		"openai/gpt-6-sol",
		"prod-chat",
		"",
	])("%s → false", (model) => {
		expect(isAnthropicAdaptiveOnlyModel(model)).toBe(false);
	});

	it("tolerates null/undefined", () => {
		expect(isAnthropicAdaptiveOnlyModel(undefined)).toBe(false);
		expect(isAnthropicAdaptiveOnlyModel(null)).toBe(false);
	});
});

describe("anthropicModelRejectsForcedToolChoice", () => {
	for (const bare of [
		"claude-opus-5-5",
		"claude-sonnet-5-5",
		"claude-fable-5-1",
		"claude-mythos-5-1",
	]) {
		it.each(spellings(bare))(`${bare}: %s → true`, (model) => {
			expect(anthropicModelRejectsForcedToolChoice(model)).toBe(true);
		});
	}

	it.each([
		// claude-opus-5 and claude-sonnet-5 ACCEPT forced tool_choice.
		"claude-opus-5",
		"anthropic/claude-opus-5",
		"system.ai.claude-opus-5",
		"databricks-claude-opus-5",
		"claude-opus-5-20260901",
		"claude-sonnet-5",
		"claude-opus-4-8",
		"anthropic/claude-opus-4.8",
		"claude-fable-5",
		"claude-mythos-5",
		"claude-opus-4-6",
		"claude-opus-5-50",
		"claude-sonnet-5-50",
		"gpt-6-sol",
		"",
	])("%s → false", (model) => {
		expect(anthropicModelRejectsForcedToolChoice(model)).toBe(false);
	});

	it("tolerates null/undefined", () => {
		expect(anthropicModelRejectsForcedToolChoice(undefined)).toBe(false);
		expect(anthropicModelRejectsForcedToolChoice(null)).toBe(false);
	});

	it("is a subset of adaptive-only", () => {
		for (const m of [
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-fable-5-1",
			"claude-mythos-5-1",
		]) {
			expect(isAnthropicAdaptiveOnlyModel(m)).toBe(true);
		}
	});
});
