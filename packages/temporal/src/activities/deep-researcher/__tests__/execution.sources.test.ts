import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAiModelWithSelection: vi.fn(),
	findMany: vi.fn(),
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: (...args: unknown[]) => mocks.generateText(...args),
	isStepCount: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		mCPConfig: {
			findMany: (...args: unknown[]) => mocks.findMany(...args),
		},
	},
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: (...args: unknown[]) =>
		mocks.retrieveWorkspaceDocumentsActivity(...args),
}));
vi.mock("../../orchestrator/utils/model-selector", () => ({
	getAiModelWithSelection: (...args: unknown[]) =>
		mocks.getAiModelWithSelection(...args),
}));

import { executeDirectResearch, executeSubAgent } from "../execution";

const input = {
	userId: "example-user",
	organizationId: "example-org",
	workspaceIds: ["example-workspace"],
};
const findings =
	"Source: **[Concurrency](https://example.com/concurrency#readers).** Confidence: 90%. According to an invented heading.";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findMany.mockResolvedValue([]);
	mocks.getAiModelWithSelection.mockResolvedValue({
		model: {},
		provider: "OPENAI",
		modelString: "example-model",
		answerSnapshot: () => undefined,
	});
	mocks.retrieveWorkspaceDocumentsActivity.mockResolvedValue({
		context: "Retrieved synthetic workspace document context.",
		chunkCount: 2,
		sources: [
			{
				id: "example-document",
				title: "Release checklist",
				type: "document",
			},
			{
				id: "example-document",
				title: "Release checklist",
				type: "document",
			},
		],
	});
	mocks.generateText
		.mockResolvedValueOnce({ text: findings, steps: [] })
		.mockResolvedValueOnce({ text: "A concise summary." });
});

const runners = {
	"sub-agent": () =>
		executeSubAgent({
			...input,
			parentQuery: "Compare concurrency modes.",
			iteration: 1,
			subTask: {
				id: "example-task",
				title: "Concurrency",
				description: "Describe concurrent access.",
				focusArea: "Reader and writer behavior",
				expectedOutput: "A concise explanation with references.",
			},
		}),
	direct: () =>
		executeDirectResearch({
			...input,
			query: "Compare concurrency modes.",
		}),
};

it("attributes a direct answer before the summary call hands off to another model", async () => {
	let snapshot = {
		provider: "OPENAI_CHATGPT_PLAN",
		modelString: "example-plan-served",
	};
	mocks.getAiModelWithSelection.mockResolvedValueOnce({
		model: {},
		provider: "OPENAI_CHATGPT_PLAN",
		modelString: "example-configured",
		answerSnapshot: () => snapshot,
	});
	mocks.generateText
		.mockReset()
		.mockResolvedValueOnce({ text: findings, steps: [] })
		.mockImplementationOnce(async () => {
			snapshot = {
				provider: "OPENAI_DIRECT",
				modelString: "example-api-summary",
			};
			return { text: "Summary" };
		});
	const result = await runners.direct();
	expect(result.model).toMatchObject({
		id: "example-plan-served",
		viaPlan: true,
	});
	expect(result.summaryModel).toMatchObject({
		id: "example-api-summary",
		viaPlan: false,
	});
});

describe.each(Object.entries(runners))("%s research sources", (_name, run) => {
	it("preserves retrieved workspace names while excluding model-generated titles and prose", async () => {
		const result = await run();
		expect(result.sources).toEqual([
			"Release checklist",
			"https://example.com/concurrency#readers",
		]);
		expect(mocks.retrieveWorkspaceDocumentsActivity).toHaveBeenCalledWith(
			expect.any(String),
			"example-user",
			"example-org",
			["example-workspace"],
			undefined,
			8,
			0.3,
		);
	});
});
