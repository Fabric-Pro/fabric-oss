/**
 * The compaction and trajectory-summary activities record their model calls
 * against the chat: the conversation in their input reaches the model
 * resolver. Without one the resolver gets no conversation.
 */

import { currentAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { generateEmbedding } from "@repo/rag";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateText: vi.fn(),
	getAiModel: vi.fn(),
	embeddingPurposes: [] as (string | undefined)[],
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: h.getAIModelWithMetadata,
	generateText: h.generateText,
}));
vi.mock("ai", () => ({ generateText: h.generateText }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../utils/model-selector", () => ({ getAiModel: h.getAiModel }));
vi.mock("@repo/rag", () => ({
	generateEmbedding: vi.fn(async () => {
		h.embeddingPurposes.push(currentAiCallPurpose());
		return { embedding: [0.1], tokens: 1 };
	}),
	executionExists: vi.fn(async () => false),
	storeExecutionSummary: vi.fn(async () => true),
	searchSimilarExecutions: vi.fn(async () => []),
}));
vi.mock("../../letta-memory-activities", () => ({
	getRoutingSuggestions: vi.fn(),
}));

import {
	embedAndStoreTrajectory,
	generateLLMSummary,
	getHybridRoutingSuggestions,
} from "../../orchestrator-memory-activities";
import { compactConversationHistoryActivity } from "../execution/compact-conversation";

beforeEach(() => {
	vi.clearAllMocks();
	h.embeddingPurposes.length = 0;
	h.getAIModelWithMetadata.mockResolvedValue({ model: { id: "m" } });
	h.getAiModel.mockResolvedValue({ id: "m" });
	h.generateText.mockResolvedValue({
		text: "A summary long enough to be kept as the trajectory summary text.",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("compactConversationHistoryActivity — usage attribution", () => {
	const input = {
		oldTurns: [
			{
				role: "user" as const,
				content: "earlier",
				timestamp: "2026-10-01T00:00:00.000Z",
			},
		],
		currentTask: "Plan the launch",
		userId: "user-1",
		organizationId: "org-1",
		maxSummaryTokens: 100,
	};

	it("hands the chat's conversation to the resolver, and none without one", async () => {
		await compactConversationHistoryActivity({
			...input,
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		await compactConversationHistoryActivity(input);

		const contexts = h.getAIModelWithMetadata.mock.calls.map((c) => c[1]);
		expect(contexts[0]).toMatchObject({
			callPurpose: "compaction",
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		expect(contexts[0]).not.toHaveProperty("workflowExecutionId");
		expect(contexts[1]).not.toHaveProperty("conversationId");
		expect(contexts[1]).not.toHaveProperty("frameId");
	});
});

describe("generateLLMSummary — usage attribution", () => {
	const input = {
		taskDescription: "Plan the launch",
		steps: [],
		outcome: "failure" as const,
		userId: "user-1",
		organizationId: "org-1",
	};

	it("hands the chat's conversation to the resolver, and none without one", async () => {
		await generateLLMSummary({
			...input,
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		await generateLLMSummary(input);

		expect(h.getAiModel.mock.calls[0][5]).toEqual({
			callPurpose: "trajectory-summary",
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		expect(h.getAiModel.mock.calls[1][5]).toEqual({
			callPurpose: "trajectory-summary",
		});
	});

	it("is reached with the conversation from embedAndStoreTrajectory", async () => {
		await embedAndStoreTrajectory({
			executionId: "exec-1",
			taskDescription: "Plan the launch",
			steps: [],
			outcome: "failure",
			durationMs: 1,
			userId: "user-1",
			organizationId: "org-1",
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});

		expect(h.getAiModel.mock.calls[0][5]).toEqual({
			callPurpose: "trajectory-summary",
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
		expect(h.embeddingPurposes).toEqual(["trajectory-embedding"]);
		expect(vi.mocked(generateEmbedding).mock.calls[0][1]).toMatchObject({
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
			featureKey: "chat-agent",
		});
	});
});

it("attributes success and failure memory-query embeddings to the same turn", async () => {
	const usageOrigin = {
		conversationId: "conversation-example",
		frameId: "frame-example",
		projectId: "project-example",
		featureKey: "chat-agent" as const,
	};
	await getHybridRoutingSuggestions({
		task: "Plan the launch",
		lettaAgentId: null,
		userId: "user-example",
		organizationId: "org-example",
		usageOrigin,
	});
	expect(generateEmbedding).toHaveBeenCalledTimes(2);
	for (const call of vi.mocked(generateEmbedding).mock.calls) {
		expect(call[1]).toMatchObject(usageOrigin);
	}
});

it("labels both hybrid-routing query embeddings without changing the lookup", async () => {
	await getHybridRoutingSuggestions({
		task: "Example task",
		lettaAgentId: null,
		userId: "example-user",
		organizationId: "example-org",
		includeFailureWarnings: true,
	});
	expect(h.embeddingPurposes).toEqual([
		"execution-search-embedding",
		"execution-search-embedding",
	]);
});
