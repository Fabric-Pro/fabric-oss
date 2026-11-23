import { describe, expect, it } from "vitest";
import { aiUsageLimitPausedText } from "../ai-usage-limit-paused-message";

describe("aiUsageLimitPausedText", () => {
	it("reads a limit's refusal as the paused state for its window, without its id", () => {
		const shown = aiUsageLimitPausedText(
			"AI usage limit exceeded: limit-example (TOKENS, DAILY) — used 10854 of 1",
		);

		expect(shown).toBe(
			"AI calls are paused — the usage limit for today is reached. Manage limits to raise it, or try again after it resets.",
		);
		expect(shown).not.toContain("limit-example");
	});

	it("reads the refusal inside a longer failure text", () => {
		expect(
			aiUsageLimitPausedText(
				"failed: AI usage limit exceeded: limit-example (SPEND_USD, MONTHLY) — used 5 of 4",
			),
		).toContain("this month");
	});

	it("is null for any other failure", () => {
		expect(
			aiUsageLimitPausedText(
				"The AI provider rejected the request (authentication). Check the provider settings.",
			),
		).toBeNull();
	});
});
