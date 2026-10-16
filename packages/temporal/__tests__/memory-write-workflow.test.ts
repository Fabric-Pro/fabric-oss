/**
 * Behavioural tests for `memoryWriteWorkflow` (ADR-022) on a time-skipping test
 * server, bundling the REAL workflows barrel (which also proves registration).
 * The workflow runs on the test's own queue; its activities run on the queue it
 * routes them to, `fabric-worker`, served by a second worker with mocked
 * activities.
 *
 * What is pinned: the write step is the only thing that touches the repository,
 * and the workflow records whatever it answers with the record activity, which
 * is retried past the write step's attempts and, when it gives up, is reported
 * (the receipt is marked failed, never left pending); a write step that fails
 * for good is recorded `FAILED UNEXPECTED`; the sync is asked to take the head
 * only after a COMMITTED outcome is recorded, and a kick that fails does not
 * fail the write; a stopped step records nothing; and the history replays.
 * Every identifier is synthetic.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/memory-write-workflow.test.ts
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryWriteOutcome } from "../src/lib/memory-write/outcome";
import {
	MEMORY_WRITE_RECORD_RETRY,
	type MemoryWriteStepResult,
	type MemoryWriteWorkflowResult,
	type RecordMemoryWriteOutcomeResult,
} from "../src/lib/memory-write-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "memoryWriteWorkflow";
const INPUT = {
	writeId: "cmemwrite00000001",
	projectId: "proj_example",
	organizationId: "org_example",
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

const COMMITTED: MemoryWriteOutcome = {
	status: "COMMITTED",
	sha: "a".repeat(40),
	ref: "main",
	fileCount: 2,
};

const outcome = (o: MemoryWriteOutcome): MemoryWriteStepResult => ({
	kind: "outcome",
	outcome: o,
});

async function run(answers: {
	/** What the write step answers; throws to fail an attempt (after its own retries). */
	write: (attempt: number) => MemoryWriteStepResult;
	/** Throws to fail an attempt of the record. */
	record?: (attempt: number) => void;
	/** Throws to fail an attempt of the report that follows a record that gave up. */
	report?: (attempt: number) => void;
	/** Throws to fail an attempt of the sync kick. */
	kick?: (attempt: number) => void;
}) {
	const calls: Call[] = [];
	let writeAttempts = 0;
	let recordAttempts = 0;
	let reportAttempts = 0;
	let kickAttempts = 0;
	const log = async (name: string, input: unknown) => {
		calls.push({ name, at: await env.currentTimeMs(), input });
	};
	const acts = {
		runMemoryWrite: vi.fn(async (input: unknown) => {
			await log("runMemoryWrite", input);
			return answers.write(++writeAttempts);
		}),
		recordMemoryWriteOutcome: vi.fn(
			async (input: {
				outcome: MemoryWriteOutcome;
			}): Promise<RecordMemoryWriteOutcomeResult> => {
				await log("recordMemoryWriteOutcome", input);
				answers.record?.(++recordAttempts);
				return { kind: "settled", status: input.outcome.status };
			},
		),
		reportMemoryWriteSettleFailed: vi.fn(async (input: unknown) => {
			await log("reportMemoryWriteSettleFailed", input);
			answers.report?.(++reportAttempts);
		}),
		startMemoryWriteSync: vi.fn(async (input: unknown) => {
			await log("startMemoryWriteSync", input);
			answers.kick?.(++kickAttempts);
		}),
	};
	const taskQueue = `memory-write-${seq++}`;
	const workflowId = `memory-write-test-${seq}`;
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
		result: result as MemoryWriteWorkflowResult,
		calls,
		workflowId,
		names: () => calls.map((c) => c.name),
	};
}

describe("memoryWriteWorkflow", () => {
	it("runs the write step with the ids and nothing else, and records what it answers", async () => {
		const { result, calls } = await run({
			write: () => outcome(COMMITTED),
		});

		expect(result).toEqual({ kind: "settled", status: "COMMITTED" });
		expect(calls[0]).toMatchObject({
			name: "runMemoryWrite",
			input: INPUT,
		});
		expect(calls[1]).toMatchObject({
			name: "recordMemoryWriteOutcome",
			input: { ...INPUT, outcome: COMMITTED },
		});
	});

	it("asks the sync to take the pushed head, naming the commit, after the commit is recorded", async () => {
		const { names, calls } = await run({ write: () => outcome(COMMITTED) });

		expect(names()).toEqual([
			"runMemoryWrite",
			"recordMemoryWriteOutcome",
			"startMemoryWriteSync",
		]);
		expect(calls[2]?.input).toEqual({ ...INPUT, sha: "a".repeat(40) });
	});

	it.each<[string, MemoryWriteOutcome]>([
		[
			"a pull request",
			{
				status: "PULL_REQUEST",
				sha: "b".repeat(40),
				ref: "main",
				branch: "fabric/memory/cmemwrite00000001",
				url: "https://example.com/pull/1",
				externalId: "1",
				reason: "configured",
				fileCount: 1,
			},
		],
		["a conflict", { status: "CONFLICT", paths: [] }],
		["a refusal", { status: "REFUSED", code: "NO_CHANGE" }],
		[
			"a failure",
			{ status: "FAILED", code: "BRANCH_BUSY", retryable: true },
		],
	])(
		"records %s and does not ask the sync for anything",
		async (_name, o) => {
			const { result, names } = await run({ write: () => outcome(o) });

			expect(result).toEqual({ kind: "settled", status: o.status });
			expect(names()).toEqual([
				"runMemoryWrite",
				"recordMemoryWriteOutcome",
			]);
		},
	);

	it("records nothing when the write step has nothing to act on", async () => {
		const { result, names } = await run({
			write: () => ({ kind: "stopped" }),
		});

		expect(result).toEqual({ kind: "stopped" });
		expect(names()).toEqual(["runMemoryWrite"]);
	});

	it("records a write step that failed for good as FAILED UNEXPECTED, so the receipt is not left pending", async () => {
		const { result, calls } = await run({
			write: () => {
				throw new Error("the worker was lost");
			},
		});

		expect(result).toEqual({ kind: "settled", status: "FAILED" });
		const recorded = calls.find(
			(c) => c.name === "recordMemoryWriteOutcome",
		);
		expect(recorded?.input).toEqual({
			...INPUT,
			outcome: { status: "FAILED", code: "UNEXPECTED", retryable: false },
		});
	});

	it("keeps recording a commit past the attempts the write step gets, and never repeats the push", async () => {
		const failures = 5;
		const { result, calls } = await run({
			write: () => outcome(COMMITTED),
			record: (attempt) => {
				if (attempt <= failures) {
					throw new Error("the database is unreachable");
				}
			},
		});

		expect(result).toEqual({ kind: "settled", status: "COMMITTED" });
		expect(
			calls.filter((c) => c.name === "recordMemoryWriteOutcome"),
		).toHaveLength(failures + 1);
		expect(calls.filter((c) => c.name === "runMemoryWrite")).toHaveLength(
			1,
		);
	});

	it("reports a record that gave up, naming the commit, and marks the write failed rather than pending", async () => {
		const { result, calls, names } = await run({
			write: () => outcome(COMMITTED),
			record: () => {
				throw new Error("the database is unreachable");
			},
		});

		expect(result).toEqual({ kind: "settled", status: "FAILED" });
		expect(
			calls.filter((c) => c.name === "recordMemoryWriteOutcome"),
		).toHaveLength(MEMORY_WRITE_RECORD_RETRY.maximumAttempts);
		const report = calls.find(
			(c) => c.name === "reportMemoryWriteSettleFailed",
		);
		expect(report?.input).toEqual({ ...INPUT, sha: "a".repeat(40) });
		expect(names()).not.toContain("startMemoryWriteSync");
	});

	it("names no commit in the report when the outcome that could not be recorded wrote nothing", async () => {
		const { calls } = await run({
			write: () => outcome({ status: "CONFLICT", paths: [] }),
			record: () => {
				throw new Error("the database is unreachable");
			},
		});

		expect(
			calls.find((c) => c.name === "reportMemoryWriteSettleFailed")
				?.input,
		).toEqual({ ...INPUT, sha: null });
	});

	it("does not fail when the report fails too", async () => {
		const { result } = await run({
			write: () => outcome(COMMITTED),
			record: () => {
				throw new Error("the database is unreachable");
			},
			report: () => {
				throw new Error("the database is still unreachable");
			},
		});

		expect(result).toEqual({ kind: "settled", status: "FAILED" });
	});

	it("does not fail a committed write because the sync could not be asked: the poll takes the head", async () => {
		const { result, calls } = await run({
			write: () => outcome(COMMITTED),
			kick: () => {
				throw new Error("temporal is unreachable");
			},
		});

		expect(result).toEqual({ kind: "settled", status: "COMMITTED" });
		const kicks = calls.filter((c) => c.name === "startMemoryWriteSync");
		expect(kicks.length).toBeGreaterThan(1);
		expect(kicks.length).toBeLessThanOrEqual(3);
		expect(calls.filter((c) => c.name === "runMemoryWrite")).toHaveLength(
			1,
		);
	});

	it("replays its own history", async () => {
		const { workflowId } = await run({ write: () => outcome(COMMITTED) });

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	});
});
