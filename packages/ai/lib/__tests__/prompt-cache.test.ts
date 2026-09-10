import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_EPHEMERAL_CACHE,
	cacheableSystem,
	isPromptCacheTarget,
	supportsAnthropicMidConversationSystem,
	withRollingCacheBreakpoint,
} from "../prompt-cache";

describe("isPromptCacheTarget", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-sonnet-4-5", true],
		["ANTHROPIC_DIRECT", "custom-model-alias", true],
		["VERCEL_GATEWAY", "claude-sonnet-4-5", true],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-4-5", true],
		["VERCEL_GATEWAY", "openai/gpt-5", false],
		["AWS_BEDROCK", "anthropic.claude-sonnet-4-5-v1:0", false],
		["OPENROUTER", "anthropic/claude-sonnet-4-5", false],
	])("targets %s / %s: %s", (provider, modelString, expected) => {
		expect(isPromptCacheTarget(provider, modelString)).toBe(expected);
	});
});

describe("supportsAnthropicMidConversationSystem", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-fable-5-1", true],
		["ANTHROPIC_DIRECT", "claude-mythos-5-20260901", true],
		["ANTHROPIC_DIRECT", "claude-opus-4-8", true],
		["ANTHROPIC_DIRECT", "claude-opus-5-20260901", true],
		["VERCEL_GATEWAY", "anthropic/claude-fable-5-1", true],
		["VERCEL_GATEWAY", "anthropic/claude-mythos-5", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-4.8", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-4-8", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-5", true],
		["ANTHROPIC_DIRECT", "claude-sonnet-5", false],
		["ANTHROPIC_DIRECT", "claude-sonnet-4-5", false],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5", false],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-4-5", false],
		["ANTHROPIC_DIRECT", "production-claude-alias", false],
		["VERCEL_GATEWAY", "claude-opus-4-8", false],
		["OPENROUTER", "anthropic/claude-opus-4-8", false],
	])("reports %s / %s: %s", (provider, modelString, expected) => {
		expect(
			supportsAnthropicMidConversationSystem(provider, modelString),
		).toBe(expected);
	});
});

describe("cacheableSystem", () => {
	it("wraps content in a system message with the ephemeral cache marker", () => {
		const msg = cacheableSystem("you are a helpful auditor");
		expect(msg).toEqual({
			role: "system",
			content: "you are a helpful auditor",
			providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
		});
	});

	it("marker is the additive anthropic ephemeral breakpoint", () => {
		expect(ANTHROPIC_EPHEMERAL_CACHE).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
	});
});

describe("withRollingCacheBreakpoint", () => {
	it("marks only the last message", () => {
		const out = withRollingCacheBreakpoint([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		]) as any[];
		expect(out[0].providerOptions).toBeUndefined();
		expect(out[1].providerOptions).toBeUndefined();
		expect(out[2].providerOptions).toEqual(ANTHROPIC_EPHEMERAL_CACHE);
	});

	it("does not mutate the input array or its messages", () => {
		const input = [
			{ role: "user", content: "a" },
			{ role: "user", content: "b" },
		];
		const out = withRollingCacheBreakpoint(input) as any[];
		expect(input[1]).not.toHaveProperty("providerOptions");
		expect(out).not.toBe(input);
	});

	it("returns a copy for empty input without throwing", () => {
		const input: unknown[] = [];
		const out = withRollingCacheBreakpoint(input);
		expect(out).toEqual([]);
		expect(out).not.toBe(input);
	});

	it("leaves a non-object last element untouched", () => {
		const out = withRollingCacheBreakpoint(["a", "b"]) as unknown[];
		expect(out).toEqual(["a", "b"]);
	});
});
