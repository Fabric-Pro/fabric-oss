import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_EPHEMERAL_CACHE,
	cacheableSystem,
	withRollingCacheBreakpoint,
} from "../prompt-cache";

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
