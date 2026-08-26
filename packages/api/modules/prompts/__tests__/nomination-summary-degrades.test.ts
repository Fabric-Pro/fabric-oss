/**
 * The change summary degrades rather than blocking review.
 *
 * FR16 asks for an AI summary of how a nominated prompt differs from the one in
 * force. The requirement attached to it is that a summariser outage must never
 * be the reason an admin cannot review a nomination.
 *
 * The model call itself lives behind the `@repo/ai` chokepoint and answers with
 * `null` for every way it can fail (see its own tests). What is under test here
 * is the product decision: what a reviewer is shown when that happens, and
 * whether they can tell it apart from a real reading of both prompts.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/nomination-summary-degrades.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { generatePromptChangeSummary } = vi.hoisted(() => ({
	generatePromptChangeSummary: vi.fn(),
}));

vi.mock("@repo/ai", () => ({ generatePromptChangeSummary }));

import { summariseNominationChange } from "../lib/nomination-summary";

const CURRENT = "Write a test case. Be brief.";
const PROPOSED =
	"Write a test case. Include preconditions, steps, and expected results.";

const summarise = (current: string | null = CURRENT) =>
	summariseNominationChange({
		proposedContent: PROPOSED,
		currentContent: current,
		userId: "user-1",
		organizationId: "org-1",
	});

describe("summariseNominationChange", () => {
	beforeEach(() => {
		generatePromptChangeSummary.mockReset();
	});

	it("passes a model-written summary through unflagged", async () => {
		generatePromptChangeSummary.mockResolvedValue(
			"Adds preconditions and expected results to every case.",
		);

		const result = await summarise();

		expect(result.degraded).toBe(false);
		expect(result.summary).toBe(
			"Adds preconditions and expected results to every case.",
		);
	});

	it("still returns a summary when no model summary is available", async () => {
		generatePromptChangeSummary.mockResolvedValue(null);

		const result = await summarise();

		expect(result.degraded).toBe(true);
		expect(result.summary).toContain("unavailable");
		// The fallback has to carry a fact the reviewer can act on, not an
		// apology — the size of the change and an instruction to read the text.
		expect(result.summary).toContain("longer");
		expect(result.summary).toContain("Compare the full text");
	});

	it("reports a shorter proposal as shorter", async () => {
		generatePromptChangeSummary.mockResolvedValue(null);

		const result = await summariseNominationChange({
			proposedContent: "Short.",
			currentContent: CURRENT,
			userId: "user-1",
		});

		expect(result.summary).toContain("shorter");
		expect(result.summary).not.toContain("longer");
	});

	it("says the action has no prompt today rather than comparing to nothing", async () => {
		generatePromptChangeSummary.mockResolvedValue(null);

		const result = await summarise(null);

		expect(result.degraded).toBe(true);
		expect(result.summary).toContain("currently has none");
		// No character-delta sentence: there is nothing to subtract from.
		expect(result.summary).not.toContain("shorter");
		expect(result.summary).not.toContain("longer");
	});

	it("asks the summariser about both prompts, not only the proposal", async () => {
		// Dropping currentContent here would leave the model describing the
		// proposal in isolation — which still reads like a plausible summary,
		// so nothing downstream would reveal it.
		generatePromptChangeSummary.mockResolvedValue("Tightens the wording.");

		await summarise();

		expect(generatePromptChangeSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedContent: PROPOSED,
				currentContent: CURRENT,
			}),
		);
	});
});
