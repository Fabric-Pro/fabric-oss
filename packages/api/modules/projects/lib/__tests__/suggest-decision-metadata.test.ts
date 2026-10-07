import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
}));

const { suggestDecisionMetadata } = await import(
	"../suggest-decision-metadata"
);

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

const baseInput = {
	title: "Adopt Temporal for durable workflows",
	decision: "Use Temporal instead of cron jobs for long-running work.",
	contextProblem: null,
	participantsText: null,
	existingTypes: ["Architecture", "QA"],
	ownerCandidates: [
		{ userId: "u-1", name: "Member One", functionTags: ["ARCHITECT"] },
	],
	tenantFilter,
};

beforeEach(() => {
	mocks.getAIModelWithMetadata.mockReset();
	mocks.generateObject.mockReset();
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
});

describe("suggestDecisionMetadata", () => {
	it("matches a proposed type case-insensitively to an existing label", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				decisionType: "architecture",
				duration: "LONG_STANDING",
				priorityFlagged: false,
				ownerUserId: "u-1",
				reason: "Infra choice.",
			},
		});
		const out = await suggestDecisionMetadata(baseInput);
		expect(out).toEqual({
			decisionType: "Architecture",
			duration: "LONG_STANDING",
			priorityFlagged: false,
			ownerUserId: "u-1",
			reason: "Infra choice.",
		});
	});

	it("keeps an unmatched label as a proposed new type", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				decisionType: "Deployment",
				duration: "SHORT_TERM",
				priorityFlagged: true,
				ownerUserId: null,
				reason: "Release-bound call.",
			},
		});
		const out = await suggestDecisionMetadata(baseInput);
		expect(out?.decisionType).toBe("Deployment");
	});

	it("drops an ownerUserId that is not one of the candidates", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				decisionType: "QA",
				duration: "LONG_STANDING",
				priorityFlagged: false,
				ownerUserId: "u-stranger",
				reason: "",
			},
		});
		await expect(suggestDecisionMetadata(baseInput)).resolves.toMatchObject(
			{
				ownerUserId: null,
			},
		);
	});

	it("returns null when the model call fails", async () => {
		mocks.generateObject.mockRejectedValue(new Error("boom"));
		await expect(suggestDecisionMetadata(baseInput)).resolves.toBeNull();
	});

	// Fizzy #2939: a refusal from the member's own ChatGPT plan is not "no
	// suggestion" — the person must learn to wait or reconnect.
	it("passes on a ChatGPT plan that needs reconnecting instead of returning null", async () => {
		const { ChatGptPlanAuthError } = await import(
			"@repo/ai/lib/chatgpt-plan/oauth"
		);
		const refusal = new ChatGptPlanAuthError(
			"Reconnect",
			"needs_reconnect",
			true,
		);
		mocks.getAIModelWithMetadata.mockRejectedValue(refusal);
		await expect(suggestDecisionMetadata(baseInput)).rejects.toBe(refusal);
	});

	it("passes on a spent ChatGPT plan instead of returning null", async () => {
		const { SubscriptionPlanExhaustedError } = await import(
			"@repo/agent-types/chatgpt-plan-fetch"
		);
		const refusal = new SubscriptionPlanExhaustedError("Spent", null);
		mocks.generateObject.mockRejectedValue(refusal);
		await expect(suggestDecisionMetadata(baseInput)).rejects.toBe(refusal);
	});
});
