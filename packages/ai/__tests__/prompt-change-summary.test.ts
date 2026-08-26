/**
 * Every way the summariser can fail is the same answer.
 *
 * This helper exists so a nomination review is never blocked on a model being
 * reachable. Its contract is deliberately narrow: a usable summary, or `null`.
 * Callers branch on one thing, and no failure mode arrives as an exception they
 * have to have anticipated.
 *
 * The case worth naming is the empty completion — it resolves successfully, so
 * without the check here it would be returned as a summary and be
 * indistinguishable from a real one all the way to the reviewer's screen.
 *
 * Run with:
 *   pnpm --filter @repo/ai test __tests__/prompt-change-summary.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateText, getAIModelWithMetadata } = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("ai", () => ({ generateText }));
vi.mock("../lib/dynamic-model-selector", () => ({ getAIModelWithMetadata }));

import { generatePromptChangeSummary } from "../lib/prompt-change-summary";

const CURRENT = "Write a test case. Be brief.";
const PROPOSED = "Write a test case. Include preconditions and expectations.";

const summarise = (currentContent: string | null = CURRENT) =>
	generatePromptChangeSummary({
		proposedContent: PROPOSED,
		currentContent,
		userId: "user-1",
		organizationId: "org-1",
	});

describe("generatePromptChangeSummary", () => {
	beforeEach(() => {
		generateText.mockReset();
		getAIModelWithMetadata.mockReset();
		getAIModelWithMetadata.mockResolvedValue({ model: {}, metadata: {} });
	});

	it("returns the model's text, trimmed", async () => {
		generateText.mockResolvedValue({ text: "  Adds preconditions.  " });

		await expect(summarise()).resolves.toBe("Adds preconditions.");
	});

	it("returns null when the model call throws", async () => {
		generateText.mockRejectedValue(new Error("upstream 503"));

		await expect(summarise()).resolves.toBeNull();
	});

	it("returns null when no model can be resolved", async () => {
		// The failure that is not a model error: no provider, no key, no credit.
		getAIModelWithMetadata.mockRejectedValue(new Error("not configured"));

		await expect(summarise()).resolves.toBeNull();
		expect(generateText).not.toHaveBeenCalled();
	});

	it("treats an empty completion as no summary", async () => {
		generateText.mockResolvedValue({ text: "   " });

		await expect(summarise()).resolves.toBeNull();
	});

	it("puts both prompts in front of the model", async () => {
		generateText.mockResolvedValue({ text: "Tightens the wording." });

		await summarise();

		const [{ prompt }] = generateText.mock.calls[0];
		expect(prompt).toContain(CURRENT);
		expect(prompt).toContain(PROPOSED);
	});

	it("tells the model when there is no current prompt to compare against", async () => {
		generateText.mockResolvedValue({ text: "Introduces a prompt." });

		await summarise(null);

		const [{ prompt }] = generateText.mock.calls[0];
		expect(prompt).toContain("no prompt bound today");
	});

	it("tags its usage so the spend is attributable", async () => {
		generateText.mockResolvedValue({ text: "Tightens the wording." });

		await summarise();

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				featureKey: "prompt-nomination-summary",
			}),
		);
	});
});
