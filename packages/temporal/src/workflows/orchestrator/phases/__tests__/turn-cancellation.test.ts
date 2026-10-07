/**
 * Advisor turn cancellation inside the iterative phase: a stop is never
 * converted into an answer.
 *
 * The phase has catches that turn an activity failure into a fallback —
 * the budget synthesis falls back to a deterministic summary, the
 * tool-result summarizer to truncation, compaction to "continue without
 * compaction", and a tool call to a tool error the model reads next round.
 * Each of those used to absorb a Stop too: a turn the user cancelled (a
 * Temporal cancel, or the turn record refusing dispatch) carried on, or
 * finished with a fallback answer reported as success.
 *
 * Under the turn contract (`cancellationAware`), every one of them rethrows
 * a stop, the turn scope reaches every model-calling activity, and an
 * answer that arrives after the run was cancelled is not returned as a
 * success.
 *
 * Same harness as the other Advisor scenario tests: the real
 * `executeIterativePhase`, the workflow SDK and the activity proxy mocked.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import type { IterativeTurnOptions } from "../../turn-contract";
import { createInitialState, type IterativeMessage } from "../../types";
import { maybeCompactConversationHistory } from "../iterative-execution";
import {
	finalResponse,
	installDefaultStubs,
	runTurn,
	type Step,
} from "./advisor-scenario-harness";

const TURN: IterativeTurnOptions = {
	cancellationAware: true,
	turnScope: {
		turnId: "turn-example-1",
		executionId: "exec-advisor-1",
		userId: "user-1",
		organizationId: "org-1",
	},
};

/** What the workflow sees when an activity refused dispatch. */
function refusedDispatch(activityType: string) {
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"1",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker-1",
		ApplicationFailure.create({
			type: "TurnNotDispatchable",
			message: "Turn may not make another model request (cancelled)",
			nonRetryable: true,
			details: [{ reason: "cancelled" }],
		}),
	);
}

/** What the workflow sees when an activity was cancelled by a Temporal cancel. */
function cancelledActivity(activityType: string) {
	return new ActivityFailure(
		"Activity cancelled",
		activityType,
		"1",
		RetryState.CANCEL_REQUESTED,
		"worker-1",
		new CancelledFailure("Activity cancelled"),
	);
}

const LARGE_OUTPUT = "z".repeat(40_000);

function throwing(error: Error): Step {
	return () => {
		throw error;
	};
}

beforeEach(() => {
	installDefaultStubs(mocks);
});

describe("a stop inside the iterative phase is never converted into an answer", () => {
	it("passes the turn scope to every model round", async () => {
		const { seen } = await runTurn(mocks, {
			message: "What is the launch date?",
			steps: [{ answer: "The 12th." }],
			turn: TURN,
		});
		expect(seen).toHaveLength(1);
		expect(
			mocks.stub("runAgentIteration").mock.calls[0]?.[0],
		).toMatchObject({ turnScope: TURN.turnScope });
	});

	it("passes the turn scope to the lookup activities, and nothing new without a turn", async () => {
		const lookups = () => {
			mocks
				.stub("retrieveWorkspaceDocumentsActivity")
				.mockResolvedValue({ context: "", chunkCount: 0 });
			mocks
				.stub("retrieveProjectContextsActivity")
				.mockResolvedValue({ context: "", chunkCount: 0 });
			mocks.stub("searchProjectTeamsMessages").mockResolvedValue({
				messages: [],
				totalCount: 0,
				query: "launch",
				searchedChats: [],
				errors: [],
			});
			mocks
				.stub("executeDatabricksKnowledgeSearchActivity")
				.mockResolvedValue({
					summary: "No matching content found.",
					chunks: [],
					failures: [],
					skippedIndexes: [],
				});
		};
		// An agent's Databricks knowledge tool, as preloading registers it.
		const preloadedResources = {
			mcpTools: [],
			agents: [],
			toolMap: {
				search_databricks_indexes: {
					serverName: "databricks-vector-search",
					definition: {
						description: "Search the Databricks knowledge base.",
						inputSchema: { type: "object", properties: {} },
					},
					dispatchMetadata: {
						integrationId: "integration-1",
						indexNames: ["catalog.idx"],
					},
				},
			},
		};
		const steps = (): Step[] => [
			{
				calls: [
					{ name: "search_tools", args: { query: "launch plan" } },
					{ name: "workspace_rag_query", args: { query: "launch" } },
					{ name: "project_rag_query", args: { query: "launch" } },
					{
						name: "search_teams_messages",
						args: { query: "launch" },
					},
					{
						name: "search_databricks_indexes",
						args: { query: "launch" },
					},
				],
			},
			{ answer: "The 12th." },
		];

		lookups();
		await runTurn(mocks, {
			message: "What is the launch date?",
			workspaceIds: ["ws-1"],
			preloadedResources,
			steps: steps(),
			turn: TURN,
		});
		const scope = { turnScope: TURN.turnScope };
		for (const name of [
			"searchAvailableTools",
			"searchAvailableAgents",
			"searchAvailableIntegrations",
			"searchProjectTeamsMessages",
			"executeDatabricksKnowledgeSearchActivity",
		]) {
			expect(mocks.stub(name).mock.calls[0]?.[0], name).toMatchObject(
				scope,
			);
		}
		// Positional activities take it as a trailing options argument.
		expect(
			mocks.stub("retrieveWorkspaceDocumentsActivity").mock.calls[0],
		).toHaveLength(8);
		expect(
			mocks.stub("retrieveWorkspaceDocumentsActivity").mock.calls[0]?.[7],
		).toEqual(scope);
		expect(
			mocks.stub("retrieveProjectContextsActivity").mock.calls[0],
		).toHaveLength(6);
		expect(
			mocks.stub("retrieveProjectContextsActivity").mock.calls[0]?.[5],
		).toEqual(scope);

		// A run with no turn schedules them exactly as before.
		installDefaultStubs(mocks);
		lookups();
		await runTurn(mocks, {
			message: "What is the launch date?",
			workspaceIds: ["ws-1"],
			preloadedResources,
			steps: steps(),
		});
		for (const name of [
			"searchAvailableTools",
			"searchAvailableAgents",
			"searchAvailableIntegrations",
			"searchProjectTeamsMessages",
			"executeDatabricksKnowledgeSearchActivity",
		]) {
			expect(
				mocks.stub(name).mock.calls[0]?.[0],
				name,
			).not.toHaveProperty("turnScope");
		}
		expect(
			mocks.stub("retrieveWorkspaceDocumentsActivity").mock.calls[0],
		).toHaveLength(7);
		expect(
			mocks.stub("retrieveProjectContextsActivity").mock.calls[0],
		).toHaveLength(5);
	});

	it("budget synthesis: a refused dispatch is not replaced by the deterministic summary", async () => {
		// A budget below the synthesis reserve exhausts before the first
		// round, so the only model call is the synthesis.
		const run = runTurn(mocks, {
			message: "Summarize the launch plan.",
			steps: [throwing(refusedDispatch("runAgentIteration"))],
			modeConfig: { maxIterations: 20, maxTotalTokens: 1 },
			turn: TURN,
		});
		const outcome = await run.then(
			(value) => ({ resolvedWith: finalResponse(value.result) }),
			(err: unknown) => err,
		);
		expect(outcome).toBeInstanceOf(ActivityFailure);
		const synthesisCall =
			mocks.stub("runAgentIteration").mock.calls[0]?.[0];
		expect(synthesisCall).toMatchObject({
			availableTools: {},
			turnScope: TURN.turnScope,
		});
		// No retry synthesis after the refusal.
		expect(mocks.stub("runAgentIteration")).toHaveBeenCalledTimes(1);
	});

	it("budget synthesis: a Temporal cancel during the synthesis is not replaced by the deterministic summary", async () => {
		const outcome = await runTurn(mocks, {
			message: "Summarize the launch plan.",
			steps: [throwing(cancelledActivity("runAgentIteration"))],
			modeConfig: { maxIterations: 20, maxTotalTokens: 1 },
			turn: TURN,
		}).then(
			(value) => ({ resolvedWith: finalResponse(value.result) }),
			(err: unknown) => err,
		);
		expect(outcome).toBeInstanceOf(ActivityFailure);
		expect(mocks.stub("runAgentIteration")).toHaveBeenCalledTimes(1);
	});

	it("summarizer: a refused dispatch is not replaced by truncation, and no further round runs", async () => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: LARGE_OUTPUT,
			success: true,
			durationMs: 1,
			cached: false,
		});
		mocks
			.stub("summarizeLargeToolResult")
			.mockRejectedValue(refusedDispatch("summarizeLargeToolResult"));

		const outcome = await runTurn(mocks, {
			message: "List every record.",
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "An answer written from a truncated result." },
			],
			turn: TURN,
		}).then(
			(value) => ({ resolvedWith: finalResponse(value.result) }),
			(err: unknown) => err,
		);

		expect(outcome).toBeInstanceOf(ActivityFailure);
		expect(
			mocks.stub("summarizeLargeToolResult").mock.calls[0]?.[0],
		).toMatchObject({ turnScope: TURN.turnScope });
		expect(mocks.stub("runAgentIteration")).toHaveBeenCalledTimes(1);
	});

	it("tool dispatch: a refused delegation is not fed back to the model as a tool error", async () => {
		mocks
			.stub("executeAgentAsTool")
			.mockRejectedValue(refusedDispatch("executeAgentAsTool"));

		const outcome = await runTurn(mocks, {
			message: "Ask the research agent.",
			steps: [
				{
					calls: [
						{
							name: "delegate_to_agent-1",
							args: { message: "research the launch" },
						},
					],
				},
				{ answer: "The delegation failed, so here is a guess." },
			],
			turn: TURN,
		}).then(
			(value) => ({ resolvedWith: finalResponse(value.result) }),
			(err: unknown) => err,
		);

		expect(outcome).toBeInstanceOf(ActivityFailure);
		expect(
			mocks.stub("executeAgentAsTool").mock.calls[0]?.[0],
		).toMatchObject({ turnScope: TURN.turnScope });
		expect(mocks.stub("runAgentIteration")).toHaveBeenCalledTimes(1);
	});

	it("an answer that arrives after the run was cancelled is not returned as a success", async () => {
		let checks = 0;
		const { result } = await runTurn(mocks, {
			message: "What is the launch date?",
			steps: [{ answer: "The 12th." }],
			// The loop's entry check sees a live run; the cancel arrives
			// while the round's activity is finishing.
			isCancelled: () => checks++ > 0,
			turn: TURN,
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("Execution cancelled");
		// The partial answer is kept for the turn record.
		expect(finalResponse(result)).toBe("The 12th.");
	});

	it("a legacy run (no turn contract) keeps the old fallbacks", async () => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: LARGE_OUTPUT,
			success: true,
			durationMs: 1,
			cached: false,
		});
		mocks
			.stub("summarizeLargeToolResult")
			.mockRejectedValue(refusedDispatch("summarizeLargeToolResult"));

		const { result } = await runTurn(mocks, {
			message: "List every record.",
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "An answer." },
			],
		});
		expect(result.success).toBe(true);
		expect(
			mocks.stub("runAgentIteration").mock.calls[0]?.[0],
		).not.toHaveProperty("turnScope");
	});
});

describe("compaction", () => {
	function compactionFixture() {
		const state = createInitialState({
			executionId: "exec-advisor-1",
			message: "Plan the launch",
			userId: "user-1",
			organizationId: "org-1",
			history: [],
		} as never);
		const history: IterativeMessage[] = Array.from(
			{ length: 16 },
			(_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `turn ${i}`,
				timestamp: "2026-10-01T00:00:00.000Z",
			}),
		);
		return { state, history };
	}

	it("a refused dispatch is not converted into 'continue without compaction'", async () => {
		mocks
			.stub("compactConversationHistoryActivity")
			.mockRejectedValue(
				refusedDispatch("compactConversationHistoryActivity"),
			);
		const { state, history } = compactionFixture();

		const outcome = await maybeCompactConversationHistory(
			state,
			history,
			10,
			90_000,
			100_000,
			"user-1",
			"org-1",
			TURN,
		).then(
			() => "continued",
			(err: unknown) => err,
		);

		expect(outcome).toBeInstanceOf(ActivityFailure);
		expect(
			mocks.stub("compactConversationHistoryActivity").mock.calls[0]?.[0],
		).toMatchObject({ turnScope: TURN.turnScope });
	});

	it("a legacy run still continues without compaction", async () => {
		mocks
			.stub("compactConversationHistoryActivity")
			.mockRejectedValue(new Error("provider unavailable"));
		const { state, history } = compactionFixture();

		await expect(
			maybeCompactConversationHistory(
				state,
				history,
				10,
				90_000,
				100_000,
				"user-1",
				"org-1",
			),
		).resolves.toBeUndefined();
	});
});
