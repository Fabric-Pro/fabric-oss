/**
 * Revising ONE existing test case against a changed feature.
 *
 * The behaviours worth pinning are the ones that decide whether a person can
 * trust the Accept button:
 *
 *  - a blank step must never reach a reviewer, because an empty row in a diff
 *    is a row they accept without reading;
 *  - "no AI provider" must stay distinguishable from "the generation failed",
 *    since one is a hint and the other is actionable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockGetModel = vi.hoisted(() => vi.fn());
const mockGetBoundPrompt = vi.hoisted(() => vi.fn());
const mockRenderTemplate = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
	generateObject: mockGenerateObject,
	zodSchema: (s: unknown) => s,
	// The prompt now asks whether a thrown error was a rejected structured
	// output before deciding to rethrow. Nothing in this suite throws one, so
	// the guard is simply false here.
	NoObjectGeneratedError: { isInstance: () => false },
}));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: mockGetBoundPrompt,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/utils", () => ({ renderTemplate: mockRenderTemplate }));
vi.mock("../lib/usage-logging", () => ({ logModelUsageAsync: vi.fn() }));

// Hoisted with the mocks: `vi.mock` factories run before module-level classes
// are initialised, so a plain `class` here is not yet defined when the factory
// reads it.
const StubProviderNotConfigured = vi.hoisted(
	() => class StubProviderNotConfigured extends Error {},
);
vi.mock("../lib/dynamic-model-selector", () => ({
	AIProviderNotConfiguredError: StubProviderNotConfigured,
	getAIModelWithMetadata: mockGetModel,
}));

import {
	reviseTestCaseSteps,
	TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY,
} from "../lib/prompts/test-case-step-revision";

const INPUT = {
	featureTitle: "Checkout",
	featureDescription: "A cart flow",
	acceptanceCriteria: "AC1: totals never go negative",
	caseTitle: "Discount applies at checkout",
	acceptanceCriterionRef: "AC 1",
	currentSteps: [{ action: "Click pay", expected: "Receipt shows" }],
};
const CONTEXT = { userId: "u1", organizationId: "org1", projectId: "p1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetModel.mockResolvedValue({
		model: { provider: "test" },
		metadata: { provider: "OPENAI_DIRECT", modelString: "gpt-4o" },
		trackUsage: vi.fn(),
	});
	mockGetBoundPrompt.mockResolvedValue(null);
	mockRenderTemplate.mockImplementation(
		async ({ template }: { template: string }) => ({
			rendered: template,
			error: null,
		}),
	);
});

describe("reviseTestCaseSteps", () => {
	it("drops steps with no action, so a blank row never reaches a reviewer", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				steps: [
					{ action: "Apply code SAVE10", expected: "Total drops" },
					{ action: "   ", expected: "orphaned expectation" },
					{ action: "", expected: "" },
				],
				rationale: "The discount is now applied before tax.",
			},
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		const result = await reviseTestCaseSteps(INPUT, CONTEXT);

		expect(result?.steps).toEqual([
			{ action: "Apply code SAVE10", expected: "Total drops" },
		]);
		expect(result?.rationale).toBe(
			"The discount is now applied before tax.",
		);
	});

	it("returns an empty step list rather than inventing coverage", async () => {
		// The caller turns this into "nothing left to verify" and stores NO
		// proposal — an empty proposal a person could accept would blank the case.
		mockGenerateObject.mockResolvedValue({
			object: { steps: [], rationale: "The feature dropped discounts." },
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		const result = await reviseTestCaseSteps(INPUT, CONTEXT);

		expect(result?.steps).toEqual([]);
		expect(result?.rationale).toBe("The feature dropped discounts.");
	});

	it("signals a missing provider with null, not an exception", async () => {
		mockGetModel.mockRejectedValue(new StubProviderNotConfigured("none"));

		expect(await reviseTestCaseSteps(INPUT, CONTEXT)).toBeNull();
	});

	it("re-throws a real generation failure instead of reporting no provider", async () => {
		// Collapsing this into `null` would tell the user to configure a provider
		// they already have, and hide a billing or rate-limit failure they can act
		// on.
		mockGenerateObject.mockRejectedValue(new Error("insufficient credits"));

		await expect(reviseTestCaseSteps(INPUT, CONTEXT)).rejects.toThrow(
			"insufficient credits",
		);
	});

	it("passes the case's current steps into the prompt", async () => {
		// Without them the model re-drafts from scratch and returns a near-
		// duplicate — the exact failure an update path exists to avoid.
		mockGenerateObject.mockResolvedValue({
			object: { steps: [{ action: "a", expected: "b" }], rationale: "r" },
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		await reviseTestCaseSteps(INPUT, CONTEXT);

		const variables = mockRenderTemplate.mock.calls[0][0].variables;
		expect(variables.currentSteps).toContain("Click pay");
		expect(variables.currentSteps).toContain("Receipt shows");
		expect(variables.caseTitle).toBe("Discount applies at checkout");
	});

	it("names a case with no steps rather than rendering an empty slot", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { steps: [{ action: "a", expected: "b" }], rationale: "r" },
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});

		await reviseTestCaseSteps({ ...INPUT, currentSteps: [] }, CONTEXT);

		expect(mockRenderTemplate.mock.calls[0][0].variables.currentSteps).toBe(
			"(this case has no steps)",
		);
	});
});

describe("fallback prompt body", () => {
	it("carries the revise-not-redraft instruction and non-escaped slots", () => {
		// Triple-stache: a feature body with <, & or quotes must not be
		// HTML-escaped into the prompt.
		expect(TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY).toContain(
			"{{{acceptanceCriteria}}}",
		);
		expect(TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY).toContain(
			"{{{currentSteps}}}",
		);
		// The instruction that separates this from the drafter.
		expect(TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY).toContain(
			"Keep every step that is still correct",
		);
	});
});
