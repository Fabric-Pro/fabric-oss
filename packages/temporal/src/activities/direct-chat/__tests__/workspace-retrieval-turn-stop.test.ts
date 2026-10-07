/**
 * Advisor Stop during the workspace_rag tool's retrieval.
 *
 * The activity caught every failure and returned a "Workspace Document
 * Error" context, so a stopped chat turn's refused or aborted query
 * embedding became tool output and the turn went on. With
 * `options.turnScope` (the trailing argument the orchestrator passes) the
 * retrieval runs inside the turn's dispatch guard and a stop leaves the
 * activity; the other callers, which pass no options, keep the fallback.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateEmbedding: vi.fn(),
	searchMultipleWorkspaces: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	db: { workspaceDocumentChunk: { findMany: vi.fn() } },
	filterWorkspaceIdsForTenant: async (params: {
		workspaceIds: string[];
	}) => ({
		allowed: params.workspaceIds,
		dropped: [],
	}),
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.3 }),
	getEffectiveRagSettings: async () => ({
		topK: 5,
		similarityThreshold: 0.3,
	}),
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: mocks.searchMultipleWorkspaces,
}));

vi.mock("@repo/rag", () => ({
	generateEmbedding: mocks.generateEmbedding,
	generateSparseVector: () => ({ indices: [], values: [] }),
}));

import { runWithTurnDispatch } from "../../orchestrator/turn-dispatch";
import { retrieveWorkspaceDocumentsActivity } from "../rag-retrieval";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

function retrieve(options?: { turnScope?: typeof TURN_SCOPE }) {
	return retrieveWorkspaceDocumentsActivity(
		"what is the launch date",
		TURN_SCOPE.userId,
		TURN_SCOPE.organizationId,
		["ws-1"],
		undefined,
		5,
		undefined,
		options,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.searchMultipleWorkspaces.mockResolvedValue([]);
});

describe("retrieveWorkspaceDocumentsActivity", () => {
	it("rethrows a stop in a chat turn", async () => {
		const stop = turnStopped();
		mocks.generateEmbedding.mockRejectedValue(stop);

		await expect(retrieve({ turnScope: TURN_SCOPE })).rejects.toBe(stop);
	});

	it("runs the retrieval inside the turn's dispatch guard", async () => {
		let guardKey: string | undefined;
		mocks.generateEmbedding.mockImplementation(async () => {
			guardKey = getDispatchGuard()?.key;
			return { embedding: [0.1, 0.2] };
		});

		await retrieve({ turnScope: TURN_SCOPE });

		expect(guardKey).toBeDefined();
	});

	it("rethrows a stop for a caller already inside a turn's guard", async () => {
		const stop = turnStopped();
		mocks.generateEmbedding.mockRejectedValue(stop);

		await expect(
			runWithTurnDispatch(TURN_SCOPE, () => retrieve()),
		).rejects.toBe(stop);
	});

	it("keeps the error context for a caller with no turn", async () => {
		mocks.generateEmbedding.mockRejectedValue(turnStopped());

		const result = await retrieve();

		expect(result.chunkCount).toBe(0);
		expect(result.context).toContain("Workspace Document Error");
	});
});
