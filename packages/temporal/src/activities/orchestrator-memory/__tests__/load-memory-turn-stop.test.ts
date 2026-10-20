/**
 * Advisor Stop while the orchestrator loads its memory context.
 *
 * Both the episodic search and the load caught every failure and degraded to
 * an empty memory context, so a stopped chat turn's refused or aborted query
 * embedding was swallowed and initialization went on. In a chat turn
 * (`turnScope`, run inside the turn's dispatch guard the way the worker's
 * interceptor runs it) a stop leaves the activity; with no turn the empty
 * context is unchanged.
 */

import { getAIEmbeddingModel } from "@repo/ai";
import { createEpisodicMemory } from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	embed: mocks.embed,
	getAIModel: vi.fn(async () => ({})),
	generateText: vi.fn(async () => ({ text: "{}" })),
	getAIEmbeddingModel: vi.fn().mockResolvedValue({ id: "embedding-model" }),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	buildOrchestratorMemoryContext: vi
		.fn()
		.mockResolvedValue({ relevantEpisodes: [] }),
	createEpisodicMemory: vi.fn().mockResolvedValue({ id: "episode-example" }),
	buildMemoryContextPromptVariables: vi.fn(() => ({})),
	getOrchestratorMemoryPreferences: vi.fn().mockResolvedValue({
		preferences: {},
		recentProjectIds: [],
		recentWorkspaceIds: [],
	}),
	getRecentEpisodes: vi.fn().mockResolvedValue([]),
	learnPattern: vi.fn(),
	updateOrchestratorMemoryPreferences: vi.fn(),
	updateRecentActivity: vi.fn(),
}));

vi.mock("../../lib/memory-context-prompt", () => ({
	resolveOrchestratorMemoryPrompt: vi.fn().mockResolvedValue(""),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/rag/lib/vector-store", () => ({
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
	storeEpisodeEmbedding: vi.fn(),
}));

import { searchSimilarEpisodes } from "@repo/rag/lib/vector-store";
import { runWithTurnDispatch } from "../../orchestrator/turn-dispatch";
import {
	createEpisodeFromExecutionActivity,
	loadOrchestratorMemoryActivity,
} from "../index";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const INPUT = {
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
	currentQuery: "what did we decide about the launch date",
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadOrchestratorMemoryActivity", () => {
	it("carries execution origin through episode creation without using its binding", async () => {
		mocks.embed.mockResolvedValue({ embedding: [0.1] });
		const usageOrigin = {
			conversationId: "turn-conversation",
			frameId: "turn-frame",
			projectId: "origin-project",
			featureKey: "chat-agent" as const,
		};
		await createEpisodeFromExecutionActivity({
			...INPUT,
			usageOrigin,
			projectId: "episode-project",
			conversationId: "execution-binding",
			executionId: "execution-example",
			taskDescription: "Plan launch",
			steps: [],
			toolsUsed: [],
			agentsUsed: [],
			outcome: "success",
			conversationStartedAt: new Date(0),
		});
		expect(getAIEmbeddingModel).toHaveBeenCalledWith({
			userId: INPUT.userId,
			organizationId: INPUT.organizationId,
			...usageOrigin,
		});
		expect(createEpisodicMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "execution-binding",
				projectId: "episode-project",
			}),
		);
	});

	it("keeps accounting origin separate from memory retrieval scope", async () => {
		mocks.embed.mockResolvedValue({ embedding: [0.1] });
		const usageOrigin = {
			conversationId: "turn-conversation",
			frameId: "turn-frame",
			projectId: "origin-project",
			featureKey: "chat-agent" as const,
		};
		await loadOrchestratorMemoryActivity({
			...INPUT,
			projectId: "retrieval-project",
			usageOrigin,
		});
		expect(getAIEmbeddingModel).toHaveBeenCalledWith({
			userId: INPUT.userId,
			organizationId: INPUT.organizationId,
			...usageOrigin,
		});
		expect(searchSimilarEpisodes).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "retrieval-project" }),
		);
	});
	it("rethrows a stop from the episodic search embedding in a chat turn", async () => {
		const stop = turnStopped();
		mocks.embed.mockRejectedValue(stop);

		await expect(
			runWithTurnDispatch(TURN_SCOPE, () =>
				loadOrchestratorMemoryActivity({
					...INPUT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("keeps the empty memory context with no turn", async () => {
		mocks.embed.mockRejectedValue(turnStopped());

		const result = await loadOrchestratorMemoryActivity(INPUT);

		expect(result.memoryContextPrompt).toBe("");
		expect(result.relevantEpisodes).toEqual([]);
	});
});

it.each(["conversation-example", undefined])(
	"uses only the supplied memory-recall conversation (%s)",
	async (usageConversationId) => {
		const { getAIEmbeddingModel } = await import("@repo/ai");
		mocks.embed.mockResolvedValue({ embedding: [0.1] });
		await loadOrchestratorMemoryActivity({ ...INPUT, usageConversationId });
		expect(
			vi.mocked(getAIEmbeddingModel).mock.calls[0][0].conversationId,
		).toBe(usageConversationId);
	},
);

it.each(["conversation-example", undefined])(
	"keeps summary binding ids out of usage (%s)",
	async (usageConversationId) => {
		const { getAIModel } = await import("@repo/ai");
		const { summarizeConversationActivity } = await import("../index");
		await summarizeConversationActivity({
			userId: "user-example",
			conversationId: "binding-example",
			usageConversationId,
			messages: [
				{ role: "user", content: "question" },
				{ role: "user", content: "follow-up" },
			],
			conversationStartedAt: new Date(0),
		});
		expect(vi.mocked(getAIModel).mock.calls[0][1]?.conversationId).toBe(
			usageConversationId,
		);
	},
);

it.each(["conversation-example", undefined])(
	"keeps episode binding ids out of usage (%s)",
	async (usageConversationId) => {
		const { createEpisodicMemory } = await import("@repo/database");
		const { getAIEmbeddingModel } = await import("@repo/ai");
		const { createEpisodicMemoryActivity } = await import("../index");
		vi.mocked(createEpisodicMemory).mockResolvedValue({
			id: "episode-example",
		} as never);
		mocks.embed.mockResolvedValue({ embedding: [0.1] });
		await createEpisodicMemoryActivity({
			userId: "user-example",
			conversationId: "execution-binding-example",
			usageConversationId,
			toolsUsed: [],
			agentsUsed: [],
			title: "summary",
			summary: "text",
			keyTopics: [],
			userIntents: [],
			outcome: "success",
			messageCount: 1,
			turnCount: 1,
			conversationStartedAt: new Date(0),
		});
		expect(
			vi.mocked(getAIEmbeddingModel).mock.calls[0][0].conversationId,
		).toBe(usageConversationId);
	},
);
