/**
 * Advisor Stop during an agent's Databricks knowledge search.
 *
 * The search is an HTTP request, not a model call, so the model factory's
 * dispatch guard never sees it. In a chat turn (`turnScope`) the activity
 * checks the turn record before sending, passes its cancellation signal to
 * the index requests, and treats a cancelled search as a stop: the client
 * records an aborted index as a per-index failure and returns the rest,
 * which after a Stop is not a result. With no turn nothing changes.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	fetchCredentials: vi.fn(),
	queryIndexes: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	checkConversationTurnDispatchable: mocks.checkDispatchable,
	fetchCredentialsByIdInTenant: mocks.fetchCredentials,
}));

vi.mock("@repo/integrations/databricks-vector-search", () => ({
	MAX_QUERY_INDEXES: 5,
	queryDatabricksVectorIndexes: mocks.queryIndexes,
}));

import { executeDatabricksKnowledgeSearchActivity } from "../databricks-knowledge";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const INPUT = {
	binding: { integrationId: "integration-1", indexNames: ["catalog.idx"] },
	args: { query: "launch plan" },
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
};

const RESULT = {
	chunks: [
		{ indexName: "catalog.idx", id: "1", content: "plan", score: 0.9 },
	],
	failures: [],
	skippedIndexes: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkDispatchable.mockResolvedValue({ ok: true });
	mocks.fetchCredentials.mockResolvedValue({ host: "example.com" });
	mocks.queryIndexes.mockResolvedValue(RESULT);
});

describe("executeDatabricksKnowledgeSearchActivity in a chat turn", () => {
	it("refuses before the request once the turn is stopped", async () => {
		mocks.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const error = await new MockActivityEnvironment()
			.run(executeDatabricksKnowledgeSearchActivity, {
				...INPUT,
				turnScope: TURN_SCOPE,
			})
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ApplicationFailure);
		expect((error as ApplicationFailure).type).toBe("TurnNotDispatchable");
		expect(mocks.checkDispatchable).toHaveBeenCalledWith(TURN_SCOPE);
		expect(mocks.queryIndexes).not.toHaveBeenCalled();
	});

	it("passes the activity's cancellation signal to the index requests", async () => {
		const env = new MockActivityEnvironment();

		await env.run(executeDatabricksKnowledgeSearchActivity, {
			...INPUT,
			turnScope: TURN_SCOPE,
		});

		const sent = mocks.queryIndexes.mock.calls[0]?.[1]?.signal as
			| AbortSignal
			| undefined;
		expect(sent).toBeDefined();
		expect(sent?.aborted).toBe(false);
	});

	it("reports a search cancelled in flight as cancelled, not as partial results", async () => {
		mocks.queryIndexes.mockImplementation(
			(_credentials: unknown, args: { signal?: AbortSignal }) =>
				new Promise((resolve) => {
					// The real client turns an aborted index into a failure
					// entry and resolves with whatever else it has.
					args.signal?.addEventListener("abort", () =>
						resolve({
							chunks: [],
							failures: [
								"catalog.idx: This operation was aborted",
							],
							skippedIndexes: [],
						}),
					);
				}),
		);
		const env = new MockActivityEnvironment();

		const running = env.run(executeDatabricksKnowledgeSearchActivity, {
			...INPUT,
			turnScope: TURN_SCOPE,
		});
		await vi.waitFor(() => expect(mocks.queryIndexes).toHaveBeenCalled());
		env.cancel();

		await expect(running).rejects.toBeInstanceOf(CancelledFailure);
	});
});

describe("executeDatabricksKnowledgeSearchActivity with no turn", () => {
	it("searches as before: no turn check, no signal", async () => {
		const result = (await new MockActivityEnvironment().run(
			executeDatabricksKnowledgeSearchActivity,
			INPUT,
		)) as Awaited<
			ReturnType<typeof executeDatabricksKnowledgeSearchActivity>
		>;

		expect(result.chunks).toHaveLength(1);
		expect(mocks.checkDispatchable).not.toHaveBeenCalled();
		expect(mocks.queryIndexes.mock.calls[0]?.[1]?.signal).toBeUndefined();
	});
});
