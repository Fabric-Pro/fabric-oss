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

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	embed: mocks.embed,
	getAIEmbeddingModel: vi.fn().mockResolvedValue({ id: "embedding-model" }),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	buildOrchestratorMemoryContext: vi
		.fn()
		.mockResolvedValue({ relevantEpisodes: [] }),
	createEpisodicMemory: vi.fn(),
	formatMemoryContextPrompt: vi.fn(() => ""),
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

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/rag/lib/vector-store", () => ({
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
	storeEpisodeEmbedding: vi.fn(),
}));

import { runWithTurnDispatch } from "../../orchestrator/turn-dispatch";
import { loadOrchestratorMemoryActivity } from "../index";

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
