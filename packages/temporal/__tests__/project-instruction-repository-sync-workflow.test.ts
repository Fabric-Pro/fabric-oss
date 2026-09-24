/**
 * Behavioural tests for `projectInstructionRepositorySyncWorkflow` on a
 * time-skipping test server, bundling the REAL workflows barrel (which is
 * also what proves registration). The sync's own activities run on the queue
 * the workflow routes them to; the child snapshot workflow and its
 * activities run on the test's own queue, inherited from the parent.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/project-instruction-repository-sync-workflow.test.ts
 */
import { resolve } from "node:path";
import { instructionSnapshotWorkflowId } from "@repo/instructions/workflow-ids";
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
	AcquireTreeResult,
	AutomaticInstructionSyncWorkflowInput,
	AwaitSnapshotSettledResult,
	BeginSyncRunInput,
	BeginSyncRunResult,
	InstructionSyncWorkflowInput,
	RecordSyncRunInput,
	RecordSyncRunResult,
	SyncRunContext,
} from "../src/lib/instruction-sync-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionRepositorySyncWorkflow";
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

function context(runKey: string): SyncRunContext {
	return {
		projectId: "proj_1",
		organizationId: "org_1",
		syncId: "sync_1",
		generation: 3,
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "",
		actingUserId: "user_1",
		trigger: "MANUAL",
		runKey,
	};
}

function childRef(snapshotId: string) {
	return {
		snapshotId,
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
	};
}

function syncMocks(
	snapshotId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		beginInstructionRepositorySyncRun: vi.fn(
			async (input: BeginSyncRunInput): Promise<BeginSyncRunResult> => ({
				ok: true,
				context: context(`sync_1:${input.workflowRunId}`),
			}),
		),
		acquireInstructionTreeFromRepository: vi.fn(
			async (): Promise<AcquireTreeResult> => ({
				outcome: "staged",
				snapshotId,
				commitSha: SHA,
			}),
		),
		awaitInstructionSnapshotSettled: vi.fn(
			async (): Promise<AwaitSnapshotSettledResult> => ({
				settled: true,
			}),
		),
		recordInstructionRepositorySyncRun: vi.fn(
			async (
				_input: RecordSyncRunInput,
			): Promise<RecordSyncRunResult> => ({
				recorded: true,
				status: "SUCCEEDED",
			}),
		),
		...overrides,
	};
}

function childMocks(overrides: Record<string, unknown> = {}) {
	return {
		verifyAndScanInstructionFiles: vi.fn(async () => ({
			ok: true,
			rejections: [],
		})),
		finalizeInstructionSnapshot: vi.fn(async () => ({
			ok: true,
			rejections: [],
		})),
		rejectInstructionSnapshot: vi.fn(async () => undefined),
		markInstructionSnapshotFailed: vi.fn(async () => ({ marked: true })),
		publishInstructionSnapshotActivity: vi.fn(async () => ({
			published: true,
		})),
		pruneInstructionSnapshots: vi.fn(async () => ({ deleted: 0 })),
		...overrides,
	};
}

let seq = 0;

async function run(
	sync: ReturnType<typeof syncMocks>,
	child: ReturnType<typeof childMocks>,
	prelude?: (taskQueue: string) => Promise<void>,
	input: InstructionSyncWorkflowInput = INPUT,
) {
	const taskQueue = `instruction-sync-${seq++}`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: child,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities: sync,
	});
	let runId = "";
	const result = await workflowWorker.runUntil(
		activityWorker.runUntil(
			(async () => {
				await prelude?.(taskQueue);
				const handle = await env.client.workflow.start(WORKFLOW_NAME, {
					args: [input],
					taskQueue,
					workflowId: `${taskQueue}-wf`,
				});
				runId = handle.firstExecutionRunId;
				return handle.result();
			})(),
		),
	);
	return { result: result as RecordSyncRunResult, runId };
}

function recorded(sync: ReturnType<typeof syncMocks>): RecordSyncRunInput {
	expect(sync.recordInstructionRepositorySyncRun).toHaveBeenCalledTimes(1);
	return sync.recordInstructionRepositorySyncRun.mock
		.calls[0]?.[0] as RecordSyncRunInput;
}

async function childStatus(snapshotId: string): Promise<string> {
	return (
		await env.client.workflow
			.getHandle(instructionSnapshotWorkflowId(snapshotId))
			.describe()
	).status.name;
}

describe("projectInstructionRepositorySyncWorkflow", () => {
	it("begins with the run id, stages, runs the snapshot workflow as a child under the acting user, then records", async () => {
		const sync = syncMocks("snap_happy");
		const child = childMocks();

		const { result, runId } = await run(sync, child);

		expect(result).toEqual({ recorded: true, status: "SUCCEEDED" });
		expect(sync.beginInstructionRepositorySyncRun).toHaveBeenCalledWith({
			...INPUT,
			workflowRunId: runId,
		});
		expect(child.verifyAndScanInstructionFiles).toHaveBeenCalledWith(
			childRef("snap_happy"),
		);
		expect(await childStatus("snap_happy")).toBe("COMPLETED");
		expect(recorded(sync)).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "MANUAL",
			workflowRunId: runId,
			context: context(`sync_1:${runId}`),
			skipped: false,
			unchanged: false,
			snapshotId: "snap_happy",
			commitSha: SHA,
			error: null,
			childResult: { status: "READY", published: true },
		});
	}, 60_000);

	it("records a skipped run without acquiring", async () => {
		const sync = syncMocks("snap_skip", {
			beginInstructionRepositorySyncRun: vi.fn(
				async (input: BeginSyncRunInput) => ({
					ok: false,
					skipped: "paused",
					context: context(`sync_1:${input.workflowRunId}`),
				}),
			),
		});
		await run(sync, childMocks());
		expect(
			sync.acquireInstructionTreeFromRepository,
		).not.toHaveBeenCalled();
		expect(recorded(sync)).toMatchObject({ skipped: true, error: null });
	}, 60_000);

	it("records NOT_CONFIGURED with no context", async () => {
		const sync = syncMocks("snap_none", {
			beginInstructionRepositorySyncRun: vi.fn(async () => ({
				ok: false,
				error: "NOT_CONFIGURED",
			})),
		});
		await run(sync, childMocks());
		expect(recorded(sync)).toMatchObject({
			context: null,
			error: "NOT_CONFIGURED",
		});
	}, 60_000);

	it("does not retry a non-retryable typed failure, and records its code and details", async () => {
		const sync = syncMocks("snap_limits", {
			acquireInstructionTreeFromRepository: vi.fn(async () => {
				throw ApplicationFailure.create({
					type: "LIMITS_EXCEEDED",
					message: "Repository sync failed: LIMITS_EXCEEDED",
					details: [{ commitSha: SHA, snapshotId: "snap_limits" }],
				});
			}),
		});
		const { result } = await run(sync, childMocks());
		expect(sync.acquireInstructionTreeFromRepository).toHaveBeenCalledTimes(
			1,
		);
		expect(result).toEqual({ recorded: true, status: "SUCCEEDED" });
		expect(recorded(sync)).toMatchObject({
			error: "LIMITS_EXCEEDED",
			commitSha: SHA,
			snapshotId: "snap_limits",
		});
	}, 60_000);

	it("retries CLONE_FAILED, and gives up after four attempts", async () => {
		const flaky = syncMocks("snap_retry", {
			acquireInstructionTreeFromRepository: vi
				.fn()
				.mockRejectedValueOnce(
					ApplicationFailure.create({
						type: "CLONE_FAILED",
						message: "x",
					}),
				)
				.mockRejectedValueOnce(
					ApplicationFailure.create({
						type: "CLONE_FAILED",
						message: "x",
					}),
				)
				.mockResolvedValue({
					outcome: "staged",
					snapshotId: "snap_retry",
					commitSha: SHA,
				}),
		});
		await run(flaky, childMocks());
		expect(
			flaky.acquireInstructionTreeFromRepository,
		).toHaveBeenCalledTimes(3);
		expect(recorded(flaky)).toMatchObject({
			error: null,
			snapshotId: "snap_retry",
		});

		const broken = syncMocks("snap_broken", {
			acquireInstructionTreeFromRepository: vi.fn(async () => {
				throw ApplicationFailure.create({
					type: "CLONE_FAILED",
					message: "x",
				});
			}),
		});
		await run(broken, childMocks());
		expect(
			broken.acquireInstructionTreeFromRepository,
		).toHaveBeenCalledTimes(4);
		expect(recorded(broken)).toMatchObject({ error: "CLONE_FAILED" });
	}, 120_000);

	it("records an unchanged run without starting a child", async () => {
		const sync = syncMocks("snap_unchanged", {
			acquireInstructionTreeFromRepository: vi.fn(async () => ({
				outcome: "unchanged",
				commitSha: SHA,
			})),
		});
		const child = childMocks();
		await run(sync, child);
		expect(child.verifyAndScanInstructionFiles).not.toHaveBeenCalled();
		expect(recorded(sync)).toMatchObject({
			unchanged: true,
			commitSha: SHA,
			snapshotId: null,
		});
	}, 60_000);

	it("still records, and completes, when the child workflow fails", async () => {
		const sync = syncMocks("snap_childfail");
		const child = childMocks({
			publishInstructionSnapshotActivity: vi.fn(async () => {
				throw ApplicationFailure.create({
					type: "BOOM",
					message: "publish exploded",
					nonRetryable: true,
				});
			}),
		});
		const { result } = await run(sync, child);
		expect(result).toEqual({ recorded: true, status: "SUCCEEDED" });
		expect(recorded(sync)).toMatchObject({
			snapshotId: "snap_childfail",
			childResult: null,
		});
	}, 60_000);

	it("adopts a child that already ran instead of starting another, and records the child's own result", async () => {
		const sync = syncMocks("snap_adopted", {
			awaitInstructionSnapshotSettled: vi.fn(async () => ({
				settled: true,
				childResult: {
					status: "READY",
					published: false,
					publishReason: "configuration_changed",
				},
			})),
		});
		const child = childMocks();
		await run(sync, child, async (taskQueue) => {
			const earlier = await env.client.workflow.start(
				"projectInstructionSnapshotWorkflow",
				{
					args: [childRef("snap_adopted")],
					taskQueue,
					workflowId: instructionSnapshotWorkflowId("snap_adopted"),
				},
			);
			await earlier.result();
		});
		// Once, by the earlier run: the sync never started a second child.
		expect(child.verifyAndScanInstructionFiles).toHaveBeenCalledTimes(1);
		expect(recorded(sync)).toMatchObject({
			childResult: {
				status: "READY",
				published: false,
				publishReason: "configuration_changed",
			},
		});
	}, 60_000);

	it("keeps the parent open while an adopted child is open, cancels it after exactly 18 pending polls, and records only once it has closed", async () => {
		let polls = 0;
		let statusAtRecord = "";
		let parentWorkflowId = "";
		const sync = syncMocks("snap_stuck", {
			awaitInstructionSnapshotSettled: vi.fn(
				async (): Promise<AwaitSnapshotSettledResult> => {
					polls++;
					if (polls <= 18) {
						return { settled: false };
					}
					return {
						settled:
							(await childStatus("snap_stuck")) !== "RUNNING",
					};
				},
			),
			recordInstructionRepositorySyncRun: vi.fn(async () => {
				statusAtRecord = await childStatus("snap_stuck");
				return { recorded: true, status: "FAILED" };
			}),
		});
		const child = childMocks({
			// Holds the child open until it is cancelled or the worker stops.
			verifyAndScanInstructionFiles: vi.fn(async () => {
				await Context.current().cancelled;
				return { ok: true, rejections: [] };
			}),
		});

		await run(sync, child, async (taskQueue) => {
			parentWorkflowId = `${taskQueue}-wf`;
			await env.client.workflow.start(
				"projectInstructionSnapshotWorkflow",
				{
					args: [childRef("snap_stuck")],
					taskQueue,
					workflowId: instructionSnapshotWorkflowId("snap_stuck"),
				},
			);
		});

		expect(statusAtRecord).not.toBe("RUNNING");
		expect(await childStatus("snap_stuck")).toBe("CANCELLED");

		// Pinned via the PARENT's own recorded history, not a real-time race
		// against when the child happens to observe its cancellation (N4):
		// the external-cancel command must be the event immediately after
		// the 18th `awaitInstructionSnapshotSettled` schedule, and before
		// the 19th — `SETTLE_POLLS_BEFORE_CANCEL`, not some other count a
		// looser `toBeGreaterThan` assertion would equally have accepted.
		const history = await env.client.workflow
			.getHandle(parentWorkflowId)
			.fetchHistory();
		let scheduledCount = 0;
		let scheduledCountAtCancel = -1;
		for (const event of history.events ?? []) {
			if (
				event.activityTaskScheduledEventAttributes?.activityType
					?.name === "awaitInstructionSnapshotSettled"
			) {
				scheduledCount++;
			}
			if (
				event.requestCancelExternalWorkflowExecutionInitiatedEventAttributes
			) {
				scheduledCountAtCancel = scheduledCount;
				break;
			}
		}
		expect(scheduledCountAtCancel).toBe(18);
	}, 120_000);

	// S1: the settle activity must retry without limit, because the parent
	// can never be allowed to record while the adopted child is still open.
	// A Temporal client error or a heartbeat blip during the 3-hour wait must
	// be retried forever rather than surfaced as a failure that lets
	// `settleAdoptedChild` return early with the child still RUNNING.
	it("retries a failing settle activity without limit, and records the child's result once it succeeds (S1)", async () => {
		const sync = syncMocks("snap_settle_retry", {
			awaitInstructionSnapshotSettled: vi
				.fn()
				.mockRejectedValueOnce(new Error("transient client error"))
				.mockRejectedValueOnce(new Error("transient client error"))
				.mockRejectedValueOnce(new Error("transient client error"))
				.mockResolvedValue({
					settled: true,
					childResult: { status: "READY", published: true },
				}),
		});
		const child = childMocks();

		await run(sync, child, async (taskQueue) => {
			const earlier = await env.client.workflow.start(
				"projectInstructionSnapshotWorkflow",
				{
					args: [childRef("snap_settle_retry")],
					taskQueue,
					workflowId:
						instructionSnapshotWorkflowId("snap_settle_retry"),
				},
			);
			await earlier.result();
		});

		expect(sync.awaitInstructionSnapshotSettled).toHaveBeenCalledTimes(4);
		expect(recorded(sync)).toMatchObject({
			childResult: { status: "READY", published: true },
		});
	}, 60_000);

	// S2: proves `WAIT_CANCELLATION_COMPLETED` actually holds the parent's
	// cancellation open until the acquire activity has genuinely stopped, not
	// merely been asked to. The mock heartbeats in a loop — required to ever
	// receive cancellation at all — and sets `acquireExited` only once its
	// own `Context.current().cancelled` promise rejects. Under the SDK
	// default (TRY_CANCEL), `record` would run before that ever happens; this
	// test was confirmed to fail under TRY_CANCEL and pass under
	// WAIT_CANCELLATION_COMPLETED before being kept.
	it("waits for the cancelled acquire activity to actually exit before recording (S2)", async () => {
		let acquireExited = false;
		let acquireExitedWhenRecorded: boolean | null = null;
		let markAcquireStarted: () => void = () => {};
		const acquireStarted = new Promise<void>((resolve) => {
			markAcquireStarted = resolve;
		});
		const sync = syncMocks("snap_cancel_acquire", {
			acquireInstructionTreeFromRepository: vi.fn(async () => {
				markAcquireStarted();
				try {
					for (;;) {
						Context.current().heartbeat();
						await Promise.race([
							Context.current().cancelled,
							new Promise((resolve) => setTimeout(resolve, 20)),
						]);
					}
				} catch (err) {
					acquireExited = true;
					// Rethrow the ORIGINAL rejection, not a new error: the
					// worker only reports this attempt as canceled (rather
					// than a plain, retryable failure) when the thrown value
					// is still recognizable as the cancellation itself.
					throw err;
				}
			}),
			recordInstructionRepositorySyncRun: vi.fn(async () => {
				acquireExitedWhenRecorded = acquireExited;
				return { recorded: true, status: "FAILED" };
			}),
		});

		const taskQueue = `instruction-sync-${seq++}`;
		const workflowId = `${taskQueue}-wf`;
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: childMocks(),
		});
		const activityWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
			activities: sync,
		});

		await workflowWorker.runUntil(
			activityWorker.runUntil(
				(async () => {
					const handle = await env.client.workflow.start(
						WORKFLOW_NAME,
						{ args: [INPUT], taskQueue, workflowId },
					);
					await acquireStarted;
					await handle.cancel();
					// Rejects with a `WorkflowFailedError` once the parent's
					// own cancellation is reported — only after the acquire
					// activity has genuinely stopped (WAIT_CANCELLATION_COMPLETED).
					await handle.result().catch(() => undefined);
				})(),
			),
		);

		expect(acquireExitedWhenRecorded).toBe(true);
		expect(sync.recordInstructionRepositorySyncRun).toHaveBeenCalledTimes(
			1,
		);
	}, 90_000);

	// S3: parent workflow cancellation. The child workflow is started for
	// real (no adoption involved) and cancellation is issued only once its
	// own activity has genuinely started, synchronized through a promise
	// resolved from inside the mock rather than a timing guess. Child
	// workflows default to `WAIT_CANCELLATION_COMPLETED`, so the child is
	// cancelled and closed before the parent's own cancellation is reported.
	it("cancels the child first, records exactly once under nonCancellable, and ends CANCELLED when the parent itself is cancelled (S3)", async () => {
		const snapshotId = "snap_cancel_parent";
		const sync = syncMocks(snapshotId);
		let markChildActivityStarted: () => void = () => {};
		const childActivityStarted = new Promise<void>((resolve) => {
			markChildActivityStarted = resolve;
		});
		const child = childMocks({
			verifyAndScanInstructionFiles: vi.fn(async () => {
				markChildActivityStarted();
				await Context.current().cancelled;
				return { ok: true, rejections: [] };
			}),
		});

		const taskQueue = `instruction-sync-${seq++}`;
		const workflowId = `${taskQueue}-wf`;
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: child,
		});
		const activityWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
			activities: sync,
		});

		const outcome = await workflowWorker.runUntil(
			activityWorker.runUntil(
				(async () => {
					const handle = await env.client.workflow.start(
						WORKFLOW_NAME,
						{ args: [INPUT], taskQueue, workflowId },
					);
					await childActivityStarted;
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
		expect(await childStatus(snapshotId)).toBe("CANCELLED");
		expect(sync.recordInstructionRepositorySyncRun).toHaveBeenCalledTimes(
			1,
		);
	}, 60_000);

	// S3: the child's own verdict was REJECTED (a secret hit or an integrity
	// failure), not a workflow failure — the workflow still completes, and
	// the rejection travels through as the recorded `childResult`.
	it("records a REJECTED child result and completes (S3)", async () => {
		const sync = syncMocks("snap_rejected");
		const child = childMocks({
			verifyAndScanInstructionFiles: vi.fn(async () => ({
				ok: false,
				rejections: [{ path: "a", reason: "secret", detail: "jwt" }],
			})),
		});

		const { result } = await run(sync, child);

		expect(result).toEqual({ recorded: true, status: "SUCCEEDED" });
		expect(recorded(sync)).toMatchObject({
			snapshotId: "snap_rejected",
			childResult: { status: "REJECTED", published: false },
		});
	}, 60_000);

	// S3: a `begin` that throws (e.g. the non-retryable input-validation
	// failure the real activity raises for a manual run with no requester)
	// never reaches `runSync`'s assignment of `state.context`. `record` must
	// still run, with a null context, and the workflow must still fail.
	it("still records with a null context, and fails, when begin throws (S3)", async () => {
		let beginRunId = "";
		const sync = syncMocks("snap_begin_throws", {
			beginInstructionRepositorySyncRun: vi.fn(
				async (input: BeginSyncRunInput) => {
					beginRunId = input.workflowRunId;
					throw ApplicationFailure.create({
						type: "INSTRUCTION_SYNC_INPUT_INVALID",
						message:
							"A manual repository sync needs the requesting member",
						nonRetryable: true,
					});
				},
			),
		});

		const failure = await run(sync, childMocks()).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(beginRunId).not.toBe("");
		expect(recorded(sync)).toMatchObject({
			// What `record` rebuilds the run key from (Finding 2).
			workflowRunId: beginRunId,
			context: null,
			skipped: false,
			unchanged: false,
			snapshotId: null,
			commitSha: null,
			error: null,
			childResult: null,
		});
	}, 60_000);

	// Finding 2: `begin` inserted the receipt and then kept failing (a
	// permission read that throws) until its retry policy was exhausted.
	// `record` still runs, with no context but with the run id, which is all
	// it needs to rebuild the run key and complete that receipt as FAILED
	// (the activity test pins the completion itself).
	it("records with the run id when begin exhausts its retries after inserting the receipt (Finding 2)", async () => {
		const runIds = new Set<string>();
		const sync = syncMocks("snap_begin_exhausted", {
			beginInstructionRepositorySyncRun: vi.fn(
				async (input: BeginSyncRunInput) => {
					runIds.add(input.workflowRunId);
					throw new Error("connection terminated");
				},
			),
		});

		const failure = await run(sync, childMocks()).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(sync.beginInstructionRepositorySyncRun).toHaveBeenCalledTimes(5);
		expect(runIds.size).toBe(1);
		expect(
			sync.acquireInstructionTreeFromRepository,
		).not.toHaveBeenCalled();
		expect(recorded(sync)).toMatchObject({
			projectId: "proj_1",
			organizationId: "org_1",
			workflowRunId: [...runIds][0],
			context: null,
			error: null,
		});
	}, 120_000);

	// Decision 44 (PR 2): an automatic start passes the project, the
	// organization, the trigger and the row it was decided on (Decision 56),
	// and no run id. The workflow hands `begin` that input whole plus its own
	// run id, and puts the run id into the state `record` rebuilds the run
	// key from, for every trigger, exactly as for a manual run.
	it.each(["POLL", "WEBHOOK"] as const)(
		"hands begin the start's whole input with its own run id, and record the same run id, for a %s start (Decisions 44 and 56)",
		async (trigger) => {
			// Exactly what the automatic starter sends (Decisions 47 and 56).
			const input: AutomaticInstructionSyncWorkflowInput = {
				projectId: "proj_1",
				organizationId: "org_1",
				trigger,
				expected: { syncId: "sync_1", generation: 3 },
			};
			const sync = syncMocks(`snap_${trigger.toLowerCase()}`);

			const { runId } = await run(sync, childMocks(), undefined, input);

			expect(sync.beginInstructionRepositorySyncRun).toHaveBeenCalledWith(
				{
					...input,
					workflowRunId: runId,
				},
			);
			expect(recorded(sync)).toMatchObject({
				trigger,
				workflowRunId: runId,
			});
		},
		60_000,
	);

	it("records a POLL run with its run id when begin fails after inserting the receipt (Decision 44)", async () => {
		const runIds = new Set<string>();
		const input: AutomaticInstructionSyncWorkflowInput = {
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
			expected: { syncId: "sync_1", generation: 3 },
		};
		const sync = syncMocks("snap_poll_begin_exhausted", {
			beginInstructionRepositorySyncRun: vi.fn(
				async (begin: BeginSyncRunInput) => {
					runIds.add(begin.workflowRunId);
					throw new Error("connection terminated");
				},
			),
		});

		const failure = await run(sync, childMocks(), undefined, input).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(runIds.size).toBe(1);
		expect(recorded(sync)).toMatchObject({
			trigger: "POLL",
			workflowRunId: [...runIds][0],
			context: null,
			error: null,
		});
	}, 120_000);

	// Finding 2: cancellation while `begin` is in flight, after its insert.
	// `begin` never heartbeats, so it cannot observe the cancellation; under
	// the SDK default (TRY_CANCEL) the workflow would run `record` at once,
	// while `begin` is still working and before its receipt is known to be
	// written. WAIT_CANCELLATION_COMPLETED holds the parent until `begin` has
	// returned, so `record` sees its context and completes that receipt.
	// Pinned the same way as the acquire test (S2): `record` captures whether
	// `begin` had exited. The test releases `begin` only after `record` was
	// called or two seconds passed, whichever is first, so under TRY_CANCEL
	// `record` runs before the release and the assertion fails.
	it("waits for an in-flight begin to finish before recording when the workflow is cancelled (Finding 2)", async () => {
		let beginExited = false;
		let beginExitedWhenRecorded: boolean | null = null;
		let markBeginStarted: () => void = () => {};
		const beginStarted = new Promise<void>((resolve) => {
			markBeginStarted = resolve;
		});
		let releaseBegin: () => void = () => {};
		const beginReleased = new Promise<void>((resolve) => {
			releaseBegin = resolve;
		});
		let markRecordCalled: () => void = () => {};
		const recordCalled = new Promise<void>((resolve) => {
			markRecordCalled = resolve;
		});
		const sync = syncMocks("snap_cancel_begin", {
			beginInstructionRepositorySyncRun: vi.fn(
				async (
					input: BeginSyncRunInput,
				): Promise<BeginSyncRunResult> => {
					// The receipt is in; the permission read is still running.
					markBeginStarted();
					await beginReleased;
					beginExited = true;
					return {
						ok: true,
						context: context(`sync_1:${input.workflowRunId}`),
					};
				},
			),
			recordInstructionRepositorySyncRun: vi.fn(async () => {
				beginExitedWhenRecorded = beginExited;
				markRecordCalled();
				return { recorded: true, status: "FAILED" };
			}),
		});

		const taskQueue = `instruction-sync-${seq++}`;
		const workflowId = `${taskQueue}-wf`;
		const workflowWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: childMocks(),
		});
		const activityWorker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
			activities: sync,
		});

		let runId = "";
		await workflowWorker.runUntil(
			activityWorker.runUntil(
				(async () => {
					const handle = await env.client.workflow.start(
						WORKFLOW_NAME,
						{ args: [INPUT], taskQueue, workflowId },
					);
					runId = handle.firstExecutionRunId;
					await beginStarted;
					await handle.cancel();
					await Promise.race([
						recordCalled,
						new Promise((resolve) => setTimeout(resolve, 2_000)),
					]);
					releaseBegin();
					await handle.result().catch(() => undefined);
				})(),
			),
		);

		expect(beginExitedWhenRecorded).toBe(true);
		expect(
			sync.acquireInstructionTreeFromRepository,
		).not.toHaveBeenCalled();
		expect(recorded(sync)).toMatchObject({
			workflowRunId: runId,
			context: context(`sync_1:${runId}`),
		});
		expect(
			(await env.client.workflow.getHandle(workflowId).describe()).status
				.name,
		).toBe("CANCELLED");
	}, 90_000);

	// S3: the default mapping for an untyped acquisition failure. The
	// existing retry-exhaustion case only proves a typed CLONE_FAILED
	// retries; a plain `Error` (a real network throw, not one of our sync
	// codes) must retry the same way and fall back to CLONE_FAILED, per
	// `typedFailure`'s default.
	it("retries an untyped acquisition error 4 times and records it as CLONE_FAILED (S3)", async () => {
		const sync = syncMocks("snap_untyped", {
			acquireInstructionTreeFromRepository: vi.fn(async () => {
				throw new Error("ECONNRESET");
			}),
		});

		await run(sync, childMocks());

		expect(sync.acquireInstructionTreeFromRepository).toHaveBeenCalledTimes(
			4,
		);
		expect(recorded(sync)).toMatchObject({ error: "CLONE_FAILED" });
	}, 60_000);
});
