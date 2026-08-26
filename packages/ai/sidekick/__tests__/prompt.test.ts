/**
 * `buildSidekickSystemPrompt()` must keep the stable instruction text at
 * position 0 and the (day-stable) date context after it — not before — so
 * provider prompt caching can match the identical prefix across turns. See
 * packages/ai/lib/__tests__/prompts.test.ts for the underlying
 * `getCurrentDateContext()` format guarantee this placement depends on.
 */
import { describe, expect, it } from "vitest";
import { buildSidekickSystemPrompt, SIDEKICK_SYSTEM_PROMPT } from "../prompt";

describe("buildSidekickSystemPrompt", () => {
	it("starts with the stable Sidekick instructions and places the date context strictly after them", () => {
		const prompt = buildSidekickSystemPrompt();

		expect(prompt.startsWith(SIDEKICK_SYSTEM_PROMPT)).toBe(true);

		// Index comparison, not just toContain — the date must come AFTER the
		// stable block ends, not merely appear somewhere in the prompt.
		const dateIndex = prompt.indexOf("Today is ");
		expect(dateIndex).toBeGreaterThanOrEqual(SIDEKICK_SYSTEM_PROMPT.length);
	});
});
