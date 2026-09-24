/**
 * Behavioural tests for `projectContextRepositorySyncWorkflow` (design
 * 2026-09-23 §5.2, Fizzy #2657) on a time-skipping test server, bundling the
 * REAL workflows barrel — which also proves it is registered there. Its
 * activities run on the queue the workflow routes them to
 * (`CONTEXT_SYNC_ACTIVITY_TASK_QUEUE`), mocked.
 *
 * What this pins:
 *  - begin → sync → record, with `record` run exactly once, in the boundary
 *    `finally`, on success, on a begin refusal, on a typed sync failure, on
 *    a cancellation and when `begin` throws;
 *  - the sync activity's retry policy: CLONE_FAILED, INTEGRATION_UNAVAILABLE
 *    and STORE_FAILED are retried (four attempts in all), every other typed
 *    failure is final; the typed failure and its commit are read from the
 *    innermost ApplicationFailure; anything untyped is CLONE_FAILED;
 *  - a cancellation is never recorded as a sync failure: `record` sees
 *    `cancelled: true` and no error, only after the cancelled sync activity
 *    has actually stopped (WAIT_CANCELLATION_COMPLETED), and the workflow
 *    ends CANCELLED;
 *  - a retryable type the activity marks non-retryable (a definitive
 *    INTEGRATION_UNAVAILABLE: no token, the integration not ACTIVE, a
 *    re-exchange that could not help) is final after one attempt;
 *  - the workflow replays deterministically against its own history.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run __tests__/project-context-repository-sync-workflow.test.ts
 */
import { resolve } from "node:path";
import { Context } from "@temporalio/activity";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	BeginContextSyncRunInput,
	BeginContextSyncRunResult,
	ContextSyncFrozenContext,
	ContextSyncWorkflowInput,
	RecordContextSyncRunInput,
	RecordContextSyncRunResult,
	SyncContextTreeResult,
} from "../src/lib/context-sync-types";
import { CONTEXT_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectContextRepositorySyncWorkflow";
const SHA = "c".repeat(40);
const INPUT = {
	projectId: "proj_1",
	organizationId: "org_1",
	trigger: "MANUAL" as const,
	requesterUserId: "user_1",
};

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

function context(runKey: string): ContextSyncFrozenContext {
	return {
		projectId: "proj_1",
		organizationId: "org_1",
		syncId: "sync_1",
		generation: 3,
		runKey,
		trigger: "MANUAL",
		repositoryIntegrationId: "int_1",
		ref: "main",
		paths: ["docs"],
		actingUserId: "user_1",
	};
}

function syncMocks(overrides: Record<string, unknown> = {}) {
	return {
		beginContextRepositorySyncRun: vi.fn(
			async (
				input: BeginContextSyncRunInput,
			): Promise<BeginContextSyncRunResult> => ({
				ok: true,
				context: context(`sync_1:${input.workflowRunId}`),
			}),
		),
		syncContextTreeFromRepository: vi.fn(
			async (): Promise<SyncContextTreeResult> => ({
				outcome: "applied",
				commitSha: SHA,
			}),
		),
		recordContextRepositorySyncRun: vi.fn(
			async (
				_input: RecordContextSyncRunInput,
			): Promise<RecordContextSyncRunResult> => ({
				recorded: true,
				status: "SUCCEEDED",
				error: null,
			}),
		),
		...overrides,
	};
}

type Mocks = ReturnType<typeof syncMocks>;

let seq = 0;

async function run(mocks: Mocks, input: ContextSyncWorkflowInput = INPUT) {
	const taskQueue = `context-sync-${seq++}`;
	const workflowId = `${taskQueue}-wf`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: {},
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: CONTEXT_SYNC_ACTIVITY_TASK_QUEUE,
		activities: mocks,
	});
	let runId = "";
	const outcome = await workflowWorker.runUntil(
		activityWorker.runUntil(
			(async () => {
				const handle = await env.client.workflow.start(WORKFLOW_NAME, {
					args: [input],
					taskQueue,
					workflowId,
				});
				runId = handle.firstExecutionRunId;
				return handle.result().then(
					(result) => ({ ok: true as const, result }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			})(),
		),
	);
	return { ...outcome, runId, workflowId };
}

function recorded(mocks: Mocks): RecordContextSyncRunInput {
	expect(mocks.recordContextRepositorySyncRun).toHaveBeenCalledTimes(1);
	return mocks.recordContextRepositorySyncRun.mock
		.calls[0]?.[0] as RecordContextSyncRunInput;
}

function failure(type: string, details?: unknown) {
	return ApplicationFailure.create({
		type,
		message: `Repository sync failed: ${type}`,
		...(details === undefined ? {} : { details: [details] }),
	});
}

describe("projectContextRepositorySyncWorkflow", () => {
	it("begins with its run id, syncs the frozen context, then records in finally and returns what record answered", async () => {
		const mocks = syncMocks();

		const outcome = await run(mocks);

		expect(outcome).toMatchObject({
			ok: true,
			result: { recorded: true, status: "SUCCEEDED", error: null },
		});
		expect(mocks.beginContextRepositorySyncRun).toHaveBeenCalledWith({
			...INPUT,
			workflowRunId: outcome.runId,
		});
		expect(mocks.syncContextTreeFromRepository).toHaveBeenCalledWith(
			context(`sync_1:${outcome.runId}`),
		);
		expect(recorded(mocks)).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "MANUAL",
			workflowRunId: outcome.runId,
			context: context(`sync_1:${outcome.runId}`),
			error: null,
			cancelled: false,
			commitSha: SHA,
		});
	}, 60_000);

	it("records a begin refusal with its context, without syncing", async () => {
		const mocks = syncMocks({
			beginContextRepositorySyncRun: vi.fn(
				async (input: BeginContextSyncRunInput) => ({
					ok: false,
					error: "RUN_IN_PROGRESS",
					context: context(`sync_1:${input.workflowRunId}`),
				}),
			),
		});

		const outcome = await run(mocks);

		expect(outcome.ok).toBe(true);
		expect(mocks.syncContextTreeFromRepository).not.toHaveBeenCalled();
		expect(recorded(mocks)).toMatchObject({
			context: context(`sync_1:${outcome.runId}`),
			error: "RUN_IN_PROGRESS",
			cancelled: false,
		});
	}, 60_000);

	it("ends an automatic run begin skipped without syncing, handing record nothing to complete (§11.1)", async () => {
		// A POLL run as the shared poll starts it: no requester, the row it
		// was decided on as `expected`.
		const automatic: ContextSyncWorkflowInput = {
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
			expected: { syncId: "sync_1", generation: 3 },
		};
		const mocks = syncMocks({
			beginContextRepositorySyncRun: vi.fn(async () => ({
				ok: false,
				error: null,
				skipped: "paused",
			})),
		});

		const outcome = await run(mocks, automatic);

		expect(outcome.ok).toBe(true);
		expect(mocks.beginContextRepositorySyncRun).toHaveBeenCalledWith({
			...automatic,
			workflowRunId: outcome.runId,
		});
		expect(mocks.syncContextTreeFromRepository).not.toHaveBeenCalled();
		expect(recorded(mocks)).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
			workflowRunId: outcome.runId,
			context: null,
			error: null,
			cancelled: false,
			commitSha: null,
		});
	}, 60_000);

	it("records NOT_CONFIGURED with no context", async () => {
		const mocks = syncMocks({
			beginContextRepositorySyncRun: vi.fn(async () => ({
				ok: false,
				error: "NOT_CONFIGURED",
			})),
		});

		await run(mocks);

		expect(recorded(mocks)).toMatchObject({
			context: null,
			error: "NOT_CONFIGURED",
		});
	}, 60_000);

	it("does not retry a final typed failure, and records its code and commit from the innermost ApplicationFailure", async () => {
		const mocks = syncMocks({
			syncContextTreeFromRepository: vi.fn(async () => {
				throw failure("PATHS_MISSING", {
					commitSha: SHA,
					counts: { paths: 2 },
				});
			}),
		});

		const outcome = await run(mocks);

		expect(outcome.ok).toBe(true);
		expect(mocks.syncContextTreeFromRepository).toHaveBeenCalledTimes(1);
		expect(recorded(mocks)).toMatchObject({
			error: "PATHS_MISSING",
			commitSha: SHA,
			cancelled: false,
		});
	}, 60_000);

	it.each(["CLONE_FAILED", "INTEGRATION_UNAVAILABLE", "STORE_FAILED"])(
		"retries %s and records the attempt that succeeded",
		async (type) => {
			const mocks = syncMocks({
				syncContextTreeFromRepository: vi
					.fn()
					.mockRejectedValueOnce(failure(type))
					.mockRejectedValueOnce(failure(type))
					.mockResolvedValue({ outcome: "applied", commitSha: SHA }),
			});

			await run(mocks);

			expect(mocks.syncContextTreeFromRepository).toHaveBeenCalledTimes(
				3,
			);
			expect(recorded(mocks)).toMatchObject({
				error: null,
				commitSha: SHA,
			});
		},
		60_000,
	);

	it("gives up after four attempts, and records an untyped failure as CLONE_FAILED", async () => {
		const mocks = syncMocks({
			syncContextTreeFromRepository: vi.fn(async () => {
				throw new TypeError("boom");
			}),
		});

		const outcome = await run(mocks);

		expect(outcome.ok).toBe(true);
		expect(mocks.syncContextTreeFromRepository).toHaveBeenCalledTimes(4);
		expect(recorded(mocks)).toMatchObject({
			error: "CLONE_FAILED",
			commitSha: null,
		});
	}, 120_000);

	it("does not retry a retryable type the activity marked non-retryable, and records it", async () => {
		const mocks = syncMocks({
			syncContextTreeFromRepository: vi.fn(async () => {
				throw ApplicationFailure.create({
					type: "INTEGRATION_UNAVAILABLE",
					message: "Repository sync failed: INTEGRATION_UNAVAILABLE",
					details: [{}],
					nonRetryable: true,
				});
			}),
		});

		await run(mocks);

		expect(mocks.syncContextTreeFromRepository).toHaveBeenCalledTimes(1);
		expect(recorded(mocks)).toMatchObject({
			error: "INTEGRATION_UNAVAILABLE",
			commitSha: null,
		});
	}, 60_000);

	it("records a cancellation as cancelled — never as CLONE_FAILED — only after the sync activity stopped, and ends CANCELLED", async () => {
		let syncExited = false;
		let syncExitedWhenRecorded: boolean | null = null;
		let markSyncStarted: () => void = () => {};
		const syncStarted = new Promise<void>((resolve) => {
			markSyncStarted = resolve;
		});
		const mocks = syncMocks({
			syncContextTreeFromRepository: vi.fn(async () => {
				markSyncStarted();
				try {
					for (;;) {
						Context.current().heartbeat();
						await Promise.race([
							Context.current().cancelled,
							new Promise((resolve) => setTimeout(resolve, 20)),
						]);
					}
				} catch (error) {
					syncExited = true;
					// The original rejection, so the attempt is reported as
					// cancelled rather than as a retryable failure.
					throw error;
				}
			}),
			recordContextRepositorySyncRun: vi.fn(async () => {
				syncExitedWhenRecorded = syncExited;
				return {
					recorded: true,
					status: "FAILED",
					error: "INTERRUPTED",
				};
			}),
		});

		const taskQueue = `context-sync-${seq++}`;
		const workflowId = `${taskQueue}-wf`;
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: {},
		});
		const activityWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: CONTEXT_SYNC_ACTIVITY_TASK_QUEUE,
			activities: mocks,
		});
		const outcome = await workflowWorker.runUntil(
			activityWorker.runUntil(
				(async () => {
					const handle = await env.client.workflow.start(
						WORKFLOW_NAME,
						{
							args: [INPUT],
							taskQueue,
							workflowId,
						},
					);
					await syncStarted;
					await handle.cancel();
					return handle.result().then(
						() => "resolved" as const,
						(error: unknown) => {
							expect(error).toBeInstanceOf(WorkflowFailedError);
							return "rejected" as const;
						},
					);
				})(),
			),
		);

		expect(outcome).toBe("rejected");
		expect(
			(await env.client.workflow.getHandle(workflowId).describe()).status
				.name,
		).toBe("CANCELLED");
		expect(syncExitedWhenRecorded).toBe(true);
		expect(recorded(mocks)).toMatchObject({
			cancelled: true,
			error: null,
			context: expect.objectContaining({ syncId: "sync_1" }),
		});
	}, 90_000);

	it("still records, with no context and its run id, and fails, when begin throws", async () => {
		const runIds = new Set<string>();
		const mocks = syncMocks({
			beginContextRepositorySyncRun: vi.fn(
				async (input: BeginContextSyncRunInput) => {
					runIds.add(input.workflowRunId);
					throw new Error("connection terminated");
				},
			),
		});

		const outcome = await run(mocks);

		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? null : outcome.error).toBeInstanceOf(
			WorkflowFailedError,
		);
		// Five attempts (CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS), one run id.
		expect(mocks.beginContextRepositorySyncRun).toHaveBeenCalledTimes(5);
		expect(runIds).toEqual(new Set([outcome.runId]));
		expect(mocks.syncContextTreeFromRepository).not.toHaveBeenCalled();
		expect(recorded(mocks)).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "MANUAL",
			workflowRunId: outcome.runId,
			context: null,
			error: "STORE_FAILED",
			cancelled: false,
			commitSha: null,
		});
	}, 120_000);

	it("records begin's own typed failure when its retries are spent", async () => {
		const mocks = syncMocks({
			beginContextRepositorySyncRun: vi.fn(async () => {
				throw ApplicationFailure.create({
					type: "RUN_IN_PROGRESS",
					message: "undescribed",
					nonRetryable: true,
				});
			}),
		});

		await run(mocks);

		expect(recorded(mocks)).toMatchObject({
			context: null,
			error: "RUN_IN_PROGRESS",
		});
	}, 60_000);

	it("replays deterministically against its own history", async () => {
		const mocks = syncMocks({
			syncContextTreeFromRepository: vi
				.fn()
				.mockRejectedValueOnce(failure("CLONE_FAILED"))
				.mockResolvedValue({ outcome: "applied", commitSha: SHA }),
		});
		const { workflowId } = await run(mocks);

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 60_000);
});
