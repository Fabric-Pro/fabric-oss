import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getModel: vi.fn(),
	generateText: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getModel,
	generateText: mocks.generateText,
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: () => undefined,
}));
vi.mock("../fabric-enrichment", () => ({
	extractFabricConfig: () => ({}),
	applyFabricEnrichment: async () => ({ fabricUsed: false }),
}));

import { executeAiGenerateTextStep } from "../ai-generate-text";

describe("workflow text model origin", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getModel.mockResolvedValue({
			model: {},
			metadata: {
				provider: "OPENAI_DIRECT",
				modelString: "example-model",
			},
			trackUsage: vi.fn(),
		});
		mocks.generateText.mockResolvedValue({ text: "Summary", usage: {} });
	});

	it("carries the actual execution without inventing a parent Workspace", async () => {
		const result = await executeAiGenerateTextStep({
			nodeConfig: { aiPrompt: "Summarise the stories." },
			inputs: {},
			userId: "user-1",
			organizationId: "org-1",
			executionId: "execution-1",
			jobType: "workflow-builder",
		});
		expect(result.success).toBe(true);
		expect(mocks.getModel).toHaveBeenCalledExactlyOnceWith(
			{ taskType: "SIMPLE" },
			{
				userId: "user-1",
				organizationId: "org-1",
				projectId: undefined,
				featureKey: "workflow",
				jobType: "workflow-builder",
				workflowExecutionId: "execution-1",
			},
		);
	});

	it("carries the server-derived Workspace alongside the execution", async () => {
		await executeAiGenerateTextStep({
			nodeConfig: { aiPrompt: "Summarise the stories." },
			inputs: {},
			userId: "user-1",
			organizationId: "org-1",
			executionId: "execution-1",
			frameId: "workspace",
		});
		expect(mocks.getModel).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({
				workflowExecutionId: "execution-1",
				frameId: "workspace",
			}),
		);
	});
});
