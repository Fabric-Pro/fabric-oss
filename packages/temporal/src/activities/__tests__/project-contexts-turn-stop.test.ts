/**
 * Advisor Stop during the project_rag_query tool's retrieval.
 *
 * `retrieveProjectContextsActivity` caught every failure and returned an
 * empty context, so a stopped chat turn's refused or aborted embedding read
 * as "no relevant content" and the turn went on. With `options.turnScope`
 * (the trailing argument the orchestrator passes) the retrieval runs inside
 * the turn's dispatch guard and a stop leaves the activity; the other
 * callers, which pass no options, keep the empty result.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	retrieveProjectContexts: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	db: {},
	getProjectContextAvailability: vi.fn(),
	getProjectRepositoryRoles: vi.fn(),
	parseRepoUrl: vi.fn(),
	tenantWhere: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	contextMetaHeader: () => "",
}));

import { retrieveProjectContextsActivity } from "../project-metadata";

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

/** Runs the activity in an activity context (its logger needs one). */
function retrieve(options?: { turnScope?: typeof TURN_SCOPE }) {
	return new MockActivityEnvironment().run(
		retrieveProjectContextsActivity,
		"what is the launch date",
		"project-1",
		TURN_SCOPE.userId,
		TURN_SCOPE.organizationId,
		5,
		options,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("retrieveProjectContextsActivity", () => {
	it("rethrows a stop in a chat turn", async () => {
		const stop = turnStopped();
		mocks.retrieveProjectContexts.mockRejectedValue(stop);

		await expect(retrieve({ turnScope: TURN_SCOPE })).rejects.toBe(stop);
	});

	it("rethrows a stop @repo/rag wrapped with its cause", async () => {
		const stop = turnStopped();
		mocks.retrieveProjectContexts.mockRejectedValue(
			new Error("Failed to retrieve project contexts: stopped", {
				cause: stop,
			}),
		);

		await expect(retrieve({ turnScope: TURN_SCOPE })).rejects.toBe(stop);
	});

	it("runs the retrieval inside the turn's dispatch guard", async () => {
		let guardKey: string | undefined;
		mocks.retrieveProjectContexts.mockImplementation(async () => {
			guardKey = getDispatchGuard()?.key;
			return [];
		});

		await retrieve({ turnScope: TURN_SCOPE });

		expect(guardKey).toBeDefined();
	});

	it("keeps the empty result for a caller with no turn", async () => {
		mocks.retrieveProjectContexts.mockRejectedValue(turnStopped());

		await expect(retrieve()).resolves.toEqual({
			context: "",
			chunkCount: 0,
		});
	});
});
