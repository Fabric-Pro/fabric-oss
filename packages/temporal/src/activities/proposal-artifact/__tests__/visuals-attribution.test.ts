/**
 * The Proposal visuals' model usage is attributed to `proposal-visuals`, not
 * to Glossy, through the real Glossy detection and extraction calls (Fizzy
 * #2801). Only the model layer and the database are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	trackUsage: vi.fn(),
}));

const database = vi.hoisted(() => ({
	db: { projectDocument: { updateMany: vi.fn() } },
	getDocumentStyle: vi.fn(),
	getRecipientBrand: vi.fn(),
}));

vi.mock("@repo/database", () => database);

// NoObjectGeneratedError is the REAL `ai` class: the code under test calls
// its `.isInstance()`, which checks a brand a stand-in would not carry.
vi.mock("@repo/ai", async () => {
	const actualAi = await vi.importActual<typeof import("ai")>("ai");
	return {
		AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
		generateObject: mocks.generateObject,
		getAIModelWithMetadata: mocks.getAIModelWithMetadata,
		NoObjectGeneratedError: actualAi.NoObjectGeneratedError,
		zodSchema: (schema: unknown) => schema,
	};
});

const { generateProposalVisuals } = await import("../visuals");

const MAIN = [
	"# Example Proposal",
	"",
	"## Timeline and Milestones",
	"",
	"Discovery starts in March and the launch follows in May.",
].join("\n");

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	organizationId: "org-1",
	userId: "user-1",
	liveRunId: "live-run-1",
	content: MAIN,
};

beforeEach(() => {
	vi.clearAllMocks();
	database.db.projectDocument.updateMany.mockResolvedValue({ count: 1 });
	database.getDocumentStyle.mockResolvedValue(null);
	database.getRecipientBrand.mockResolvedValue(null);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { provider: "OPENAI" },
		trackUsage: mocks.trackUsage,
	});
	mocks.generateObject
		.mockResolvedValueOnce({
			object: {
				opportunities: [
					{ sectionRef: "sec-1", kind: "timeline", reason: "Dates." },
				],
			},
		})
		.mockResolvedValueOnce({
			object: {
				spec: {
					kind: "timeline",
					title: null,
					items: [
						{
							date: "March",
							label: "Discovery",
							description: null,
						},
						{ date: "May", label: "launch", description: null },
					],
				},
			},
		});
});

describe("Proposal visuals — model attribution", () => {
	it("resolves every model call under proposal-visuals, as the triggering member in the run's organization", async () => {
		await generateProposalVisuals({ ...INPUT, planEligible: true });

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledTimes(2);
		for (const [options, context] of mocks.getAIModelWithMetadata.mock
			.calls) {
			expect(options).toEqual({ taskType: "COMPLEX" });
			expect(context).toEqual({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				featureKey: "proposal-visuals",
				planEligible: true,
			});
		}
	});

	it("leaves the plan decision to the resolver when the run is not plan-eligible", async () => {
		await generateProposalVisuals(INPUT);

		for (const [, context] of mocks.getAIModelWithMetadata.mock.calls) {
			expect(context).not.toHaveProperty("planEligible");
			expect(context.featureKey).toBe("proposal-visuals");
		}
	});
});
