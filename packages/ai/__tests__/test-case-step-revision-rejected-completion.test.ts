/**
 * What happens when the structured-output schema rejects the completion.
 *
 * The salvage function has its own unit tests, but nothing covered the wiring
 * that reaches it: the sibling suite stubs `NoObjectGeneratedError.isInstance`
 * to false, so the recovery branch never ran there. A change that stopped
 * calling salvage — or called it with the wrong field — would have passed both
 * suites while every rejected completion went back to being a 500.
 *
 * Both directions matter. Recovering a usable revision must not become
 * recovering nothing and returning it anyway: a proposal a reviewer can accept
 * must have content, so a completion with nothing in it still throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockGetModel = vi.hoisted(() => vi.fn());
const mockGetBoundPrompt = vi.hoisted(() => vi.fn());
const mockRenderTemplate = vi.hoisted(() => vi.fn());

// Hoisted for the same reason as the sibling suite: `vi.mock` factories run
// before module-level classes are initialised.
const StubNoObjectGenerated = vi.hoisted(
	() =>
		class StubNoObjectGenerated extends Error {
			text?: string;
		},
);
const StubProviderNotConfigured = vi.hoisted(
	() => class StubProviderNotConfigured extends Error {},
);

vi.mock("ai", () => ({
	generateObject: mockGenerateObject,
	zodSchema: (s: unknown) => s,
	// A real discriminator, not a constant: a test that answers true for every
	// error would also pass if the prompt salvaged the wrong ones.
	NoObjectGeneratedError: {
		isInstance: (error: unknown) => error instanceof StubNoObjectGenerated,
	},
}));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: mockGetBoundPrompt,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/utils", () => ({ renderTemplate: mockRenderTemplate }));
vi.mock("../lib/usage-logging", () => ({ logModelUsageAsync: vi.fn() }));
vi.mock("../lib/dynamic-model-selector", () => ({
	AIProviderNotConfiguredError: StubProviderNotConfigured,
	getAIModelWithMetadata: mockGetModel,
}));

import { reviseTestCaseSteps } from "../lib/prompts/test-case-step-revision";

const INPUT = {
	featureTitle: "Checkout",
	featureDescription: "A cart flow",
	acceptanceCriteria: "AC1: totals never go negative",
	caseTitle: "Discount applies at checkout",
	acceptanceCriterionRef: "AC 1",
	currentSteps: [{ action: "Click pay", expected: "Receipt shows" }],
};
const CONTEXT = { userId: "u1", organizationId: "org1", projectId: "p1" };

function rejectedCompletion(text: string): Error {
	const error = new StubNoObjectGenerated("could not parse object");
	error.text = text;
	return error;
}

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

describe("reviseTestCaseSteps, when the schema rejects the completion", () => {
	it("returns the recovered revision instead of failing the request", async () => {
		mockGenerateObject.mockRejectedValue(
			rejectedCompletion(
				JSON.stringify({
					rationale: "The fix inverts the case's expected outcome.",
					steps: "<step><action>Publish the announcement, then read it</action><expected>It is marked read</expected></step><step><action>Run the next delivery pass</action><expected>The recipient is not notified again</expected></step>",
				}),
			),
		);

		const result = await reviseTestCaseSteps(INPUT, CONTEXT);

		expect(result?.steps).toEqual([
			{
				action: "Publish the announcement, then read it",
				expected: "It is marked read",
			},
			{
				action: "Run the next delivery pass",
				expected: "The recipient is not notified again",
			},
		]);
		expect(result?.rationale).toContain("inverts");
	});

	it("still throws when the completion holds nothing to recover", async () => {
		mockGenerateObject.mockRejectedValue(
			rejectedCompletion("the model apologised and wrote prose"),
		);

		await expect(reviseTestCaseSteps(INPUT, CONTEXT)).rejects.toThrow(
			"could not parse object",
		);
	});

	it("does not salvage an error that is not a rejected completion", async () => {
		// A billing or rate-limit failure must stay a failure — salvaging one
		// would report a revision nobody generated.
		mockGenerateObject.mockRejectedValue(new Error("rate limit exceeded"));

		await expect(reviseTestCaseSteps(INPUT, CONTEXT)).rejects.toThrow(
			"rate limit exceeded",
		);
	});
});
