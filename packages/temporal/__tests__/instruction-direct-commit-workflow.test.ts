/**
 * Behavioural tests for `projectInstructionDirectCommitWorkflow` (Fizzy #2878
 * §10) on a time-skipping test server, bundling the REAL workflows barrel
 * (which also proves registration). The workflow runs on the test's own queue;
 * its activities run on the queue it routes them to, `fabric-worker`, served
 * by a second worker with mocked activities.
 *
 * What is pinned: the workflow waits for the snapshot's validation on the
 * counted 2, 4, 8, 15, 30 s sleeps and runs the git-writing activity only
 * after the readiness check answered `ready`; it never runs it for a rejected
 * or settled snapshot; it gives up on validation after thirty minutes and
 * says so to the activity; and its history replays. Every identifier is
 * synthetic.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/instruction-direct-commit-workflow.test.ts
 */
import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CommitToSyncedBranchResult,
	type ConfirmingSyncInput,
	DIRECT_COMMIT_MAX_ATTEMPTS,
	DIRECT_COMMIT_VALIDATION_WAIT_MS,
	type DirectCommitReadinessInput,
	type DirectCommitReadinessResult,
	type DirectCommitWorkflowResult,
	RECORD_MAX_ATTEMPTS,
	type RevertCommitWorkflowInput,
	type RevertCommitWorkflowResult,
} from "../src/lib/instruction-direct-commit-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionDirectCommitWorkflow";
const INPUT = { snapshotId: "snap_example", organizationId: "org_example" };
const CONFIRM: ConfirmingSyncInput = {
	projectId: "proj_example",
	organizationId: "org_example",
	syncId: "sync_example",
	generation: 4,
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

type Call = { name: string; at: number; input: unknown };

let seq = 0;

async function run(answers: {
	readiness: (
		input: DirectCommitReadinessInput,
		n: number,
	) => DirectCommitReadinessResult;
	commit?: () => CommitToSyncedBranchResult;
	/** Throws to fail an attempt of the activity that records a pushed commit. */
	record?: (attempt: number) => void;
	/** Throws to fail an attempt of the activity that asks the sync to take the head. */
	confirm?: (attempt: number) => void;
	/** Throws to fail an attempt of the activity that records an outcome that wrote nothing. */
	settlement?: (attempt: number) => void;
	/** Throws to fail an attempt of the report that follows a record that gave up. */
	report?: (attempt: number) => void;
	/** Throws to fail an attempt of the commit activity (after its own retries are spent). */
	commitFailure?: (attempt: number) => void;
}) {
	const calls: Call[] = [];
	let reads = 0;
	let recordAttempts = 0;
	let confirmAttempts = 0;
	let settlementAttempts = 0;
	let reportAttempts = 0;
	let commitAttempts = 0;
	const acts = {
		recordDirectCommitSettlement: vi.fn(
			async (input: { outcome: { outcome: string } }) => {
				calls.push({
					name: "recordDirectCommitSettlement",
					at: await env.currentTimeMs(),
					input,
				});
				answers.settlement?.(++settlementAttempts);
				return {
					kind: "settled" as const,
					outcome: input.outcome.outcome,
				};
			},
		),
		reportDirectCommitSettleFailed: vi.fn(async (input: unknown) => {
			calls.push({
				name: "reportDirectCommitSettleFailed",
				at: await env.currentTimeMs(),
				input,
			});
			answers.report?.(++reportAttempts);
		}),
		recordPushedDirectCommit: vi.fn(async (input: unknown) => {
			calls.push({
				name: "recordPushedDirectCommit",
				at: await env.currentTimeMs(),
				input,
			});
			answers.record?.(++recordAttempts);
			return {
				kind: "settled" as const,
				outcome: "committed" as const,
				confirm: CONFIRM,
			};
		}),
		startConfirmingInstructionSync: vi.fn(async (input: unknown) => {
			calls.push({
				name: "startConfirmingInstructionSync",
				at: await env.currentTimeMs(),
				input,
			});
			answers.confirm?.(++confirmAttempts);
		}),
		checkDirectCommitReadiness: vi.fn(
			async (input: DirectCommitReadinessInput) => {
				calls.push({
					name: "checkDirectCommitReadiness",
					at: await env.currentTimeMs(),
					input,
				});
				return answers.readiness(input, reads++);
			},
		),
		commitToSyncedBranch: vi.fn(async (input: unknown) => {
			calls.push({
				name: "commitToSyncedBranch",
				at: await env.currentTimeMs(),
				input,
			});
			answers.commitFailure?.(++commitAttempts);
			return (
				answers.commit?.() ?? {
					kind: "settled" as const,
					outcome: "committed",
				}
			);
		}),
	};
	const taskQueue = `instruction-direct-commit-${seq++}`;
	const workflowId = `project-instruction-direct-commit-test-${seq}`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities: acts,
	});
	const handle = await env.client.workflow.start(WORKFLOW_NAME, {
		args: [INPUT],
		taskQueue,
		workflowId,
	});
	const result = await workflowWorker.runUntil(
		activityWorker.runUntil(handle.result()),
	);
	return {
		result: result as DirectCommitWorkflowResult,
		calls,
		workflowId,
		names: () => calls.map((c) => c.name),
	};
}

describe("projectInstructionDirectCommitWorkflow", () => {
	it("commits once the snapshot is ready, passing the ids and nothing else", async () => {
		const { result, calls } = await run({
			readiness: () => ({ kind: "ready" }),
		});

		expect(result).toEqual({ kind: "settled", outcome: "committed" });
		expect(calls.map((c) => c.name)).toEqual([
			"checkDirectCommitReadiness",
			"commitToSyncedBranch",
		]);
		expect(calls[1]?.input).toEqual(INPUT);
	});

	it("records a pushed commit with its own activity and does not settle the row itself", async () => {
		const { result, calls } = await run({
			readiness: () => ({ kind: "ready" }),
			commit: () => ({ kind: "pushed", sha: "a".repeat(40) }),
		});

		expect(result).toEqual({ kind: "settled", outcome: "committed" });
		expect(calls.map((c) => c.name)).toEqual([
			"checkDirectCommitReadiness",
			"commitToSyncedBranch",
			"recordPushedDirectCommit",
			"startConfirmingInstructionSync",
		]);
		expect(calls[2]?.input).toEqual({ ...INPUT, sha: "a".repeat(40) });
	});

	describe("asking the sync to take the pushed head", () => {
		const pushed = () => ({
			kind: "pushed" as const,
			sha: "a".repeat(40),
		});
		const refused = () => {
			throw ApplicationFailure.retryable(
				"A repository sync run is open",
				"SYNC_RUN_OPEN",
			);
		};

		it("names the row the commit was made against, once the commit is recorded", async () => {
			const { calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: pushed,
			});

			const start = calls.filter(
				(c) => c.name === "startConfirmingInstructionSync",
			);
			expect(start).toHaveLength(1);
			expect(start[0]?.input).toEqual(CONFIRM);
		});

		it("is not asked for a commit that was not pushed", async () => {
			const { names } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: () => ({ kind: "settled", outcome: "unchanged" }),
			});

			expect(names()).not.toContain("startConfirmingInstructionSync");
		});

		it("starts the run for the new head after the open run ends: a refused start is retried on a 30 s backoff that doubles", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: pushed,
				confirm: (attempt) => {
					if (attempt <= 3) {
						refused();
					}
				},
			});

			expect(result).toEqual({ kind: "settled", outcome: "committed" });
			const starts = calls.filter(
				(c) => c.name === "startConfirmingInstructionSync",
			);
			expect(starts).toHaveLength(4);
			const gaps = starts
				.slice(1)
				.map((c, i) => c.at - (starts[i]?.at ?? 0));
			expect(gaps.map((g) => Math.round(g / 1000))).toEqual([
				30, 60, 120,
			]);
		});

		it("gives up after thirty minutes without failing the workflow: the commit is recorded, and the next poll takes the head", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: pushed,
				confirm: refused,
			});

			expect(result).toEqual({ kind: "settled", outcome: "committed" });
			const starts = calls.filter(
				(c) => c.name === "startConfirmingInstructionSync",
			);
			expect(starts.length).toBeGreaterThanOrEqual(6);
			const span =
				(starts[starts.length - 1]?.at ?? 0) - (starts[0]?.at ?? 0);
			expect(span).toBeLessThanOrEqual(30 * 60_000);
			expect(
				calls.filter((c) => c.name === "commitToSyncedBranch"),
				"the push is not repeated",
			).toHaveLength(1);
		});
	});

	it("keeps recording a pushed commit past the attempts the commit activity gets, then settles", async () => {
		const failures = DIRECT_COMMIT_MAX_ATTEMPTS + 3;
		const { result, calls } = await run({
			readiness: () => ({ kind: "ready" }),
			commit: () => ({ kind: "pushed", sha: "b".repeat(40) }),
			record: (attempt) => {
				if (attempt <= failures) {
					throw new Error("the database is unreachable");
				}
			},
		});

		expect(result).toEqual({ kind: "settled", outcome: "committed" });
		expect(
			calls.filter((c) => c.name === "recordPushedDirectCommit"),
		).toHaveLength(failures + 1);
		expect(
			calls.filter((c) => c.name === "commitToSyncedBranch"),
			"the push is not repeated",
		).toHaveLength(1);
	});

	describe("recording what the commit step decided", () => {
		const moved = (): CommitToSyncedBranchResult => ({
			kind: "outcome",
			outcome: { outcome: "branch-moved" },
		});
		const unreachable = () => {
			throw new Error("the database is unreachable");
		};
		const refusedForGood = () => {
			throw ApplicationFailure.nonRetryable(
				"A database write was refused",
				"RECORD_REJECTED",
			);
		};
		const count = (calls: Call[], name: string) =>
			calls.filter((c) => c.name === name).length;

		it.each<[string, CommitToSyncedBranchResult]>([
			[
				"unchanged",
				{
					kind: "outcome",
					outcome: { outcome: "unchanged", sha: "a".repeat(40) },
				},
			],
			[
				"branch-moved",
				{ kind: "outcome", outcome: { outcome: "branch-moved" } },
			],
			[
				"failed",
				{
					kind: "outcome",
					outcome: {
						outcome: "failed",
						code: "REVERT_CONFLICT",
						retryable: false,
					},
				},
			],
		])(
			"records a %s outcome that wrote nothing with its own activity, passing the outcome",
			async (name, answer) => {
				const { result, calls } = await run({
					readiness: () => ({ kind: "ready" }),
					commit: () => answer,
				});

				expect(result).toEqual({ kind: "settled", outcome: name });
				expect(calls.map((c) => c.name)).toEqual([
					"checkDirectCommitReadiness",
					"commitToSyncedBranch",
					"recordDirectCommitSettlement",
				]);
				expect(calls[2]?.input).toEqual({
					...INPUT,
					outcome:
						answer.kind === "outcome" ? answer.outcome : undefined,
				});
			},
		);

		it("keeps recording such an outcome past the attempts the commit activity gets, then settles", async () => {
			const failures = DIRECT_COMMIT_MAX_ATTEMPTS + 3;

			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: moved,
				settlement: (attempt) => {
					if (attempt <= failures) {
						unreachable();
					}
				},
			});

			expect(result).toEqual({
				kind: "settled",
				outcome: "branch-moved",
			});
			expect(count(calls, "recordDirectCommitSettlement")).toBe(
				failures + 1,
			);
			expect(count(calls, "reportDirectCommitSettleFailed")).toBe(0);
		});

		it("gives up on an outcome after a hundred attempts, reports it once and settles failed, never pending", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: moved,
				settlement: unreachable,
			});

			expect(result).toEqual({ kind: "settled", outcome: "failed" });
			expect(count(calls, "recordDirectCommitSettlement")).toBe(
				RECORD_MAX_ATTEMPTS,
			);
			const reports = calls.filter(
				(c) => c.name === "reportDirectCommitSettleFailed",
			);
			expect(reports).toHaveLength(1);
			expect(reports[0]?.input).toEqual({ ...INPUT, sha: null });
		}, 120_000);

		it("gives up on a pushed commit after a hundred attempts, naming the commit in the report, and does not ask for a sync run", async () => {
			const sha = "e".repeat(40);

			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: () => ({ kind: "pushed", sha }),
				record: unreachable,
			});

			expect(result).toEqual({ kind: "settled", outcome: "failed" });
			expect(count(calls, "recordPushedDirectCommit")).toBe(
				RECORD_MAX_ATTEMPTS,
			);
			expect(
				calls
					.filter((c) => c.name === "reportDirectCommitSettleFailed")
					.map((c) => c.input),
			).toEqual([{ ...INPUT, sha }]);
			expect(count(calls, "startConfirmingInstructionSync")).toBe(0);
			expect(
				count(calls, "commitToSyncedBranch"),
				"the push is not repeated",
			).toBe(1);
		}, 120_000);

		it("stops at the first attempt for a write the database will always refuse, and reports it", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: () => ({ kind: "pushed", sha: "e".repeat(40) }),
				record: refusedForGood,
			});

			expect(result).toEqual({ kind: "settled", outcome: "failed" });
			expect(count(calls, "recordPushedDirectCommit")).toBe(1);
			expect(count(calls, "reportDirectCommitSettleFailed")).toBe(1);
		});

		it("stops at the first attempt for a failure typed as one a retry cannot fix, even when it is thrown as retryable", async () => {
			const { calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: moved,
				settlement: () => {
					throw ApplicationFailure.create({
						message: "validation",
						type: "PrismaClientValidationError",
						nonRetryable: false,
					});
				},
			});

			expect(count(calls, "recordDirectCommitSettlement")).toBe(1);
			expect(count(calls, "reportDirectCommitSettleFailed")).toBe(1);
		});

		it("does not fail the workflow when the report itself cannot be made", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commit: moved,
				settlement: refusedForGood,
				report: unreachable,
			});

			expect(result).toEqual({ kind: "settled", outcome: "failed" });
			expect(
				count(calls, "reportDirectCommitSettleFailed"),
			).toBeGreaterThan(1);
		});

		it("records a commit step that failed for good (attempts spent, or the worker lost) as failed, never pending", async () => {
			const { result, calls } = await run({
				readiness: () => ({ kind: "ready" }),
				commitFailure: () => {
					throw ApplicationFailure.nonRetryable(
						"the worker is gone",
						"WORKER_LOST",
					);
				},
			});

			expect(result).toEqual({ kind: "settled", outcome: "failed" });
			expect(calls.map((c) => c.name)).toEqual([
				"checkDirectCommitReadiness",
				"commitToSyncedBranch",
				"recordDirectCommitSettlement",
			]);
			expect(calls[2]?.input).toEqual({
				...INPUT,
				outcome: {
					outcome: "failed",
					code: "UNEXPECTED",
					retryable: false,
				},
			});
		});
	});

	it("waits for validation on the 2, 4, 8, 15, 30 s sleeps and never commits before ready", async () => {
		const { result, calls } = await run({
			readiness: (_input, n) =>
				n < 6 ? { kind: "pending" } : { kind: "ready" },
		});

		expect(result).toEqual({ kind: "settled", outcome: "committed" });
		const checks = calls.filter(
			(c) => c.name === "checkDirectCommitReadiness",
		);
		expect(checks).toHaveLength(7);
		const gaps = checks.slice(1).map((c, i) => c.at - (checks[i]?.at ?? 0));
		expect(gaps.map((g) => Math.round(g / 1000))).toEqual([
			2, 4, 8, 15, 30, 30,
		]);
		const commit = calls.find((c) => c.name === "commitToSyncedBranch");
		expect(commit?.at).toBeGreaterThanOrEqual(
			checks[6]?.at ?? Number.POSITIVE_INFINITY,
		);
		expect(calls[calls.length - 1]?.name).toBe("commitToSyncedBranch");
	});

	it("never runs the git-writing activity for a snapshot the scan rejected or one already settled", async () => {
		const { result, names } = await run({
			readiness: () => ({ kind: "stop" }),
		});

		expect(result).toEqual({ kind: "stopped" });
		expect(names()).toEqual(["checkDirectCommitReadiness"]);
	});

	it("waits again when the row left READY between the readiness answer and the commit", async () => {
		let committed = 0;
		const { result, names } = await run({
			readiness: () => ({ kind: "ready" }),
			commit: () => {
				committed++;
				return committed === 1
					? { kind: "not_ready" }
					: { kind: "settled", outcome: "unchanged" };
			},
		});

		expect(result).toEqual({ kind: "settled", outcome: "unchanged" });
		expect(names()).toEqual([
			"checkDirectCommitReadiness",
			"commitToSyncedBranch",
			"checkDirectCommitReadiness",
			"commitToSyncedBranch",
		]);
	});

	it("ends quietly when the commit activity says the row is settled or not a commit", async () => {
		const { result } = await run({
			readiness: () => ({ kind: "ready" }),
			commit: () => ({ kind: "stopped" }),
		});

		expect(result).toEqual({ kind: "stopped" });
	});

	it("tells the readiness activity once thirty minutes of waiting have passed, and stops on its answer", async () => {
		const { result, calls } = await run({
			readiness: (input) =>
				input.deadlineReached ? { kind: "stop" } : { kind: "pending" },
		});

		expect(result).toEqual({ kind: "stopped" });
		const checks = calls.filter(
			(c) => c.name === "checkDirectCommitReadiness",
		);
		const flagged = checks.filter(
			(c) => (c.input as DirectCommitReadinessInput).deadlineReached,
		);
		expect(flagged).toHaveLength(1);
		expect(checks[checks.length - 1]).toBe(flagged[0]);
		const first = checks[0]?.at ?? 0;
		expect((flagged[0]?.at ?? 0) - first).toBeGreaterThanOrEqual(
			DIRECT_COMMIT_VALIDATION_WAIT_MS,
		);
		expect(calls.some((c) => c.name === "commitToSyncedBranch")).toBe(
			false,
		);
	});

	it("replays its own history", async () => {
		const { workflowId } = await run({
			readiness: (_input, n) =>
				n < 2 ? { kind: "pending" } : { kind: "ready" },
		});

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	});
});

const REVERT_INPUT: RevertCommitWorkflowInput = {
	projectId: "proj_example",
	organizationId: "org_example",
	userId: "user_example",
	sha: "c".repeat(40),
	requestId: "req_example_revert",
	author: { name: "Example Member", email: "noreply@example.com" },
	committer: { name: "Fabric", email: "noreply@example.com" },
	committedAt: "2026-10-03T10:00:00Z",
};

async function runRevert(
	answer: RevertCommitWorkflowResult,
	record: (attempt: number) => void = () => {},
	confirm: ConfirmingSyncInput | null = CONFIRM,
) {
	const calls: Call[] = [];
	let recordAttempts = 0;
	const acts = {
		revertCommitOnSyncedBranch: vi.fn(async (input: unknown) => {
			calls.push({
				name: "revertCommitOnSyncedBranch",
				at: await env.currentTimeMs(),
				input,
			});
			return answer;
		}),
		recordRevertedCommit: vi.fn(
			async (input: unknown, reverted: unknown) => {
				calls.push({
					name: "recordRevertedCommit",
					at: await env.currentTimeMs(),
					input: { input, reverted },
				});
				record(++recordAttempts);
				return confirm;
			},
		),
		startConfirmingInstructionSync: vi.fn(async (input: unknown) => {
			calls.push({
				name: "startConfirmingInstructionSync",
				at: await env.currentTimeMs(),
				input,
			});
		}),
		reportRevertRecordFailed: vi.fn(
			async (input: unknown, reverted: unknown) => {
				calls.push({
					name: "reportRevertRecordFailed",
					at: await env.currentTimeMs(),
					input: { input, reverted },
				});
			},
		),
	};
	const taskQueue = `instruction-revert-commit-${seq++}`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities: acts,
	});
	const handle = await env.client.workflow.start(
		"projectInstructionRevertCommitWorkflow",
		{
			args: [REVERT_INPUT],
			taskQueue,
			workflowId: `project-instruction-revert-commit-test-${seq}`,
		},
	);
	const result = await workflowWorker.runUntil(
		activityWorker.runUntil(handle.result()),
	);
	return { result: result as RevertCommitWorkflowResult, calls };
}

describe("projectInstructionRevertCommitWorkflow", () => {
	const reverted: RevertCommitWorkflowResult = {
		kind: "reverted",
		sha: "d".repeat(40),
		ref: "main",
		fileCount: 3,
	};

	it("records a revert the branch holds with its own activity, passing the request and the commit", async () => {
		const { result, calls } = await runRevert(reverted);

		expect(result).toEqual(reverted);
		expect(calls.map((c) => c.name)).toEqual([
			"revertCommitOnSyncedBranch",
			"recordRevertedCommit",
			"startConfirmingInstructionSync",
		]);
		expect(calls[1]?.input).toEqual({
			input: REVERT_INPUT,
			reverted: { sha: "d".repeat(40), ref: "main", fileCount: 3 },
		});
		expect(calls[2]?.input).toEqual(CONFIRM);
	});

	it("gives up on the audit record after a hundred attempts, reports it once, and still answers reverted", async () => {
		const { result, calls } = await runRevert(reverted, () => {
			throw new Error("the database is unreachable");
		});

		expect(result).toEqual(reverted);
		expect(
			calls.filter((c) => c.name === "recordRevertedCommit"),
		).toHaveLength(RECORD_MAX_ATTEMPTS);
		const reports = calls.filter(
			(c) => c.name === "reportRevertRecordFailed",
		);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.input).toEqual({
			input: REVERT_INPUT,
			reverted: { sha: "d".repeat(40) },
		});
		expect(
			calls.some((c) => c.name === "startConfirmingInstructionSync"),
		).toBe(false);
		expect(
			calls.filter((c) => c.name === "revertCommitOnSyncedBranch"),
			"the revert is not repeated",
		).toHaveLength(1);
	}, 120_000);

	it("stops at the first attempt for a write the database will always refuse, and reports it", async () => {
		const { result, calls } = await runRevert(reverted, () => {
			throw ApplicationFailure.nonRetryable(
				"A database write was refused",
				"RECORD_REJECTED",
			);
		});

		expect(result).toEqual(reverted);
		expect(
			calls.filter((c) => c.name === "recordRevertedCommit"),
		).toHaveLength(1);
		expect(
			calls.filter((c) => c.name === "reportRevertRecordFailed"),
		).toHaveLength(1);
	});

	it("asks for no run when the project has no sync any more", async () => {
		const { result, calls } = await runRevert(reverted, () => {}, null);

		expect(result).toEqual(reverted);
		expect(calls.map((c) => c.name)).toEqual([
			"revertCommitOnSyncedBranch",
			"recordRevertedCommit",
		]);
	});

	it("keeps recording past the attempts the revert gets, without reverting twice, and still answers reverted", async () => {
		const failures = DIRECT_COMMIT_MAX_ATTEMPTS + 3;

		const { result, calls } = await runRevert(reverted, (attempt) => {
			if (attempt <= failures) {
				throw new Error("the database is unreachable");
			}
		});

		expect(result).toEqual(reverted);
		expect(
			calls.filter((c) => c.name === "recordRevertedCommit"),
		).toHaveLength(failures + 1);
		expect(
			calls.filter((c) => c.name === "revertCommitOnSyncedBranch"),
		).toHaveLength(1);
	});

	it.each<RevertCommitWorkflowResult>([
		{ kind: "unchanged", sha: "e".repeat(40) },
		{ kind: "refused", code: "REVERT_CONFLICT" },
		{ kind: "protected" },
		{ kind: "busy" },
		{ kind: "failed", code: "GIT_FAILED" },
	])(
		"records nothing for a revert that wrote no commit (%o)",
		async (answer) => {
			const { result, calls } = await runRevert(answer);

			expect(result).toEqual(answer);
			expect(calls.map((c) => c.name)).toEqual([
				"revertCommitOnSyncedBranch",
			]);
		},
	);
});
