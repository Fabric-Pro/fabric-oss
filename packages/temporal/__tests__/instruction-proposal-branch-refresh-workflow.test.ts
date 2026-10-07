/**
 * The explicit native branch Refresh observes exactly one provider state. A
 * terminal result wakes the canonical branch workflow so it can classify the
 * pending membership immediately; OPEN never starts additional work. A frozen
 * pre-wake history proves deployed refresh runs remain replayable.
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ReconcileBranchInput,
	ReconcileBranchResult,
	WakeBranchInput,
} from "../src/activities/lib/instruction-branch-types";
import {
	assertMayContinue,
	withProposalDeadline,
} from "../src/activities/lib/instruction-proposal-boundary";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../src/task-queues";
import type { ProposalBranchRefreshWorkflowInput } from "../src/workflows/instruction-proposal-branch-refresh";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const LEGACY_WORKFLOWS_PATH = resolve(
	__dirname,
	"helpers",
	"legacy-instruction-proposal-branch-refresh",
);
const WORKFLOW_NAME = "projectInstructionProposalBranchRefreshWorkflow";
const PATCH = "instruction-proposal-branch-refresh-terminal-wake-v1";
const INPUT: ProposalBranchRefreshWorkflowInput = {
	branchId: "branch_example",
	projectId: "project_example",
	organizationId: "org_example",
	expectedAttempt: 4,
};

let environment: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let legacyWorkflowBundle: WorkflowBundleWithSourceMap;
let sequence = 0;

beforeAll(async () => {
	environment = await TestWorkflowEnvironment.createTimeSkipping();
	[workflowBundle, legacyWorkflowBundle] = await Promise.all([
		bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }),
		bundleWorkflowCode({ workflowsPath: LEGACY_WORKFLOWS_PATH }),
	]);
}, 120_000);

afterAll(async () => {
	await environment?.teardown();
});

type Activities = {
	reconcileInstructionProposalBranch: ReturnType<typeof vi.fn>;
	wakeInstructionProposalBranch: ReturnType<typeof vi.fn>;
	/** Called only when a wake got past the real proposal deadline. */
	woke: ReturnType<typeof vi.fn>;
};

function activities(
	state: ReconcileBranchResult["state"],
	options: { reconcileError?: Error; wakeError?: Error } = {},
): Activities {
	const woke = vi.fn();
	return {
		woke,
		reconcileInstructionProposalBranch: vi.fn(
			async (
				_input: ReconcileBranchInput,
			): Promise<ReconcileBranchResult> => {
				if (options.reconcileError) {
					throw options.reconcileError;
				}
				return { state };
			},
		),
		// The real deadline rule, under the real activity context: a
		// start-to-close no longer than its margin aborts before any effect,
		// as it did on staging when the wake had 10 seconds.
		wakeInstructionProposalBranch: vi.fn(async (input: WakeBranchInput) =>
			withProposalDeadline(input, async () => {
				assertMayContinue();
				if (options.wakeError) {
					throw options.wakeError;
				}
				woke(input);
				return { woken: true };
			}),
		),
	};
}

async function run(
	activities: Activities,
	options: {
		bundle?: WorkflowBundleWithSourceMap;
		input?: ProposalBranchRefreshWorkflowInput;
	} = {},
): Promise<{ result: ReconcileBranchResult; workflowId: string }> {
	const taskQueue = `instruction-proposal-branch-refresh-${sequence++}`;
	const workflowId = `${taskQueue}-workflow`;
	const workflowWorker = await Worker.create({
		connection: environment.nativeConnection,
		taskQueue,
		workflowBundle: options.bundle ?? workflowBundle,
	});
	const reconcileWorker = await Worker.create({
		connection: environment.nativeConnection,
		taskQueue: "project-instructions",
		activities: {
			reconcileInstructionProposalBranch:
				activities.reconcileInstructionProposalBranch,
		},
	});
	const wakeWorker = await Worker.create({
		connection: environment.nativeConnection,
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		activities: {
			wakeInstructionProposalBranch:
				activities.wakeInstructionProposalBranch,
		},
	});
	const handle = await environment.client.workflow.start(WORKFLOW_NAME, {
		args: [options.input ?? INPUT],
		taskQueue,
		workflowId,
		// What the API starts it with (`proposal-branch-refresh-workflow.ts`).
		workflowExecutionTimeout: "75 seconds",
	});
	const result = await workflowWorker.runUntil(
		reconcileWorker.runUntil(wakeWorker.runUntil(handle.result())),
	);
	return { result: result as ReconcileBranchResult, workflowId };
}

function patchMarkers(history: {
	events?: Array<{
		markerRecordedEventAttributes?: {
			markerName?: string | null;
			details?: Record<
				string,
				{ payloads?: Array<{ data?: Uint8Array | null }> | null }
			> | null;
		} | null;
	}> | null;
}): string[] {
	return (history.events ?? [])
		.map((event) => event.markerRecordedEventAttributes)
		.filter((attributes) => attributes?.markerName === "core_patch")
		.flatMap((attributes) =>
			Object.values(attributes?.details ?? {}).flatMap((detail) =>
				(detail.payloads ?? []).map((payload) =>
					Buffer.from(payload.data ?? new Uint8Array()).toString(
						"utf8",
					),
				),
			),
		);
}

describe("projectInstructionProposalBranchRefreshWorkflow", () => {
	it.each(["CLOSED", "MERGED"] as const)(
		"wakes the canonical branch workflow after a %s observation",
		async (state) => {
			const calls = activities(state);
			const { result, workflowId } = await run(calls);

			expect(result).toEqual({ state });
			expect(calls.wakeInstructionProposalBranch).toHaveBeenCalledWith({
				branchId: INPUT.branchId,
				projectId: INPUT.projectId,
				organizationId: INPUT.organizationId,
			});
			// Past the deadline rule, not just scheduled: staging's 10-second
			// wake was called every time and never got this far.
			expect(calls.woke).toHaveBeenCalledTimes(1);
			const history = await environment.client.workflow
				.getHandle(workflowId)
				.fetchHistory();
			expect(patchMarkers(history).join("\n")).toContain(PATCH);
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					workflowId,
				),
			).resolves.toBeUndefined();
		},
		60_000,
	);

	it("does not wake the branch workflow for OPEN", async () => {
		const calls = activities("OPEN");
		await expect(run(calls)).resolves.toMatchObject({
			result: { state: "OPEN" },
		});
		expect(calls.wakeInstructionProposalBranch).not.toHaveBeenCalled();
	}, 60_000);

	it("does not wake the branch workflow when observation fails", async () => {
		const calls = activities("OPEN", {
			reconcileError: new Error("provider unavailable"),
		});
		await expect(run(calls)).rejects.toThrow("Workflow execution failed");
		expect(calls.wakeInstructionProposalBranch).not.toHaveBeenCalled();
	}, 60_000);

	it("still answers with the observation when the wake fails", async () => {
		const calls = activities("CLOSED", {
			wakeError: new Error("worker unavailable"),
		});
		await expect(run(calls)).resolves.toMatchObject({
			result: { state: "CLOSED" },
		});
		expect(calls.wakeInstructionProposalBranch).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("leaves the wake to the sweeper for a run started without a project id", async () => {
		const calls = activities("MERGED");
		await expect(
			run(calls, {
				input: {
					branchId: INPUT.branchId,
					organizationId: INPUT.organizationId,
					expectedAttempt: INPUT.expectedAttempt,
				},
			}),
		).resolves.toMatchObject({ result: { state: "MERGED" } });
		expect(calls.wakeInstructionProposalBranch).not.toHaveBeenCalled();
	}, 60_000);

	it("replays a pre-wake history without a project id or wake command", async () => {
		const calls = activities("CLOSED");
		const { workflowId } = await run(calls, {
			bundle: legacyWorkflowBundle,
			input: {
				branchId: INPUT.branchId,
				organizationId: INPUT.organizationId,
				expectedAttempt: INPUT.expectedAttempt,
			},
		});
		expect(calls.wakeInstructionProposalBranch).not.toHaveBeenCalled();
		const history = await environment.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		expect(patchMarkers(history)).toEqual([]);
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 60_000);
});
