import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn(), resolve: vi.fn() }));
vi.mock("@repo/ai", () => ({
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.resolve,
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../orchestrator/utils/model-selector", () => ({
	getAiModel: vi.fn(),
}));

import { aggregateResults } from "../aggregation";

const report = {
	title: "Example report",
	executiveSummary: "Example summary",
	sections: [],
	methodology: "Compared evidence",
	citedSources: [],
};
const completed = {
	subTaskId: "example-task",
	title: "Example",
	status: "completed" as const,
	findings: "Example findings",
	sources: [],
	confidence: 80,
	duration: 10,
};
beforeEach(() => vi.resetAllMocks());

describe("research synthesis served identity", () => {
	it("freezes prose identity before report generation changes the served snapshot", async () => {
		const metadata = {
			modelString: "example-configured",
			provider: "OPENAI_CHATGPT_PLAN",
			answerSnapshot: {
				modelString: "example-prose",
				provider: "OPENAI_CHATGPT_PLAN",
			},
		};
		mocks.resolve.mockResolvedValue({
			model: {},
			metadata,
			trackUsage: vi.fn(),
		});
		mocks.generateText
			.mockResolvedValueOnce({
				text: "# Findings\nEvidence supports this result.",
			})
			.mockImplementationOnce(async () => {
				metadata.answerSnapshot = {
					modelString: "example-report",
					provider: "OPENAI_DIRECT",
				};
				return { text: JSON.stringify(report) };
			});
		const output = await aggregateResults({
			query: "Example question",
			userId: "example-user",
			organizationId: "example-org",
			subAgentResults: [completed],
		});
		expect(output.model).toMatchObject({
			id: "example-prose",
			viaPlan: true,
		});
		expect(output.reportModel).toMatchObject({
			id: "example-report",
			viaPlan: false,
		});
	});
	it("leaves the static all-subagents-failed output unlabeled", async () => {
		mocks.resolve.mockResolvedValue({
			model: {},
			metadata: {
				modelString: "example-configured",
				provider: "OPENAI_DIRECT",
			},
			trackUsage: vi.fn(),
		});
		const output = await aggregateResults({
			query: "Example question",
			userId: "example-user",
			subAgentResults: [],
		});
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(output.model).toBeUndefined();
		expect(output.reportModel).toBeUndefined();
	});
});
