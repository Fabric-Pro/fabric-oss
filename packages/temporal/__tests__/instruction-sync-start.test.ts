import type { InstructionSyncTrigger } from "@repo/database";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getHandle: vi.fn(),
	describe: vi.fn(),
}));

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: m.start, getHandle: m.getHandle },
	})),
}));

import {
	type RepositorySyncStartResult,
	startAutomaticInstructionSync,
} from "../src/activities/lib/instruction-sync-start";
import type { InstructionSyncTrigger as WorkflowTrigger } from "../src/lib/instruction-sync-types";

const WORKFLOW_ID = "project-instruction-repository-sync-proj_1";
const EXPECTED = { syncId: "sync_1", generation: 3 };
/** What the poll passes: the claimed row's id, and that row as `expected`. */
const POLL = {
	syncId: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	trigger: "POLL",
	expected: EXPECTED,
} as const;

beforeEach(() => {
	m.start.mockReset();
	m.getHandle.mockReset();
	m.describe.mockReset();
	m.getHandle.mockReturnValue({ describe: m.describe });
});

function alreadyStarted(): WorkflowExecutionAlreadyStartedError {
	return new WorkflowExecutionAlreadyStartedError(
		"Workflow execution already started",
		WORKFLOW_ID,
		"projectInstructionRepositorySyncWorkflow",
	);
}

describe("startAutomaticInstructionSync (spec §6.1)", () => {
	it("takes every trigger but MANUAL, straight from the run row's enum, and reports the run it reached (Decisions 47 and 56)", () => {
		// Checked by `tsc`, not at run time: a trigger a later migration adds
		// to the enum is accepted here, and by the workflow, with no edit.
		expectTypeOf<
			Parameters<typeof startAutomaticInstructionSync>[0]["trigger"]
		>().toEqualTypeOf<Exclude<InstructionSyncTrigger, "MANUAL">>();
		expectTypeOf<WorkflowTrigger>().toEqualTypeOf<InstructionSyncTrigger>();
		expectTypeOf<
			Awaited<ReturnType<typeof startAutomaticInstructionSync>>
		>().toEqualTypeOf<RepositorySyncStartResult>();
		expectTypeOf<RepositorySyncStartResult>().toEqualTypeOf<{
			outcome: "started" | "already_running";
			workflowId: string;
			runId: string;
			runKey: string;
		}>();
	});

	it("starts the project's sync workflow with the same id, queue and conflict policy as a manual start, carrying the expected row, and reports the new run", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });

		await expect(startAutomaticInstructionSync(POLL)).resolves.toEqual({
			outcome: "started",
			workflowId: WORKFLOW_ID,
			runId: "run_1",
			// The key `begin` gives this run's receipt.
			runKey: "sync_1:run_1",
		});

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRepositorySyncWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: WORKFLOW_ID,
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						projectId: "proj_1",
						organizationId: "org_1",
						trigger: "POLL",
						expected: EXPECTED,
					},
				],
			},
		);
		// No reuse policy: the id is per project and every run reuses it.
		// No memo without a decorator: a schedule-originated start has no
		// request context.
		const options = m.start.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(options).not.toHaveProperty("workflowIdReusePolicy");
		expect(options).not.toHaveProperty("memo");
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("sends no expected row when the caller passes none", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });
		await startAutomaticInstructionSync({
			syncId: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
		});
		expect(m.start.mock.calls[0]?.[1]).toMatchObject({
			args: [
				{
					projectId: "proj_1",
					organizationId: "org_1",
					trigger: "POLL",
				},
			],
		});
		expect(m.start.mock.calls[0]?.[1].args[0]).not.toHaveProperty(
			"expected",
		);
	});

	it("applies the caller's decorator to the start options, as the webhook does for its correlation memo (Decision 46)", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });
		function withMemo<T extends object>(options: T): T {
			return { ...options, memo: { correlationId: "corr_1" } };
		}

		await startAutomaticInstructionSync(
			{ ...POLL, trigger: "WEBHOOK" },
			withMemo,
		);

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRepositorySyncWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: WORKFLOW_ID,
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						projectId: "proj_1",
						organizationId: "org_1",
						trigger: "WEBHOOK",
						expected: EXPECTED,
					},
				],
				memo: { correlationId: "corr_1" },
			},
		);
	});

	it("reports an open run as already running, with that run's id from describe, and never starts twice (Decision 56)", async () => {
		m.start.mockRejectedValue(alreadyStarted());
		m.describe.mockResolvedValue({ runId: "run_open" });

		await expect(startAutomaticInstructionSync(POLL)).resolves.toEqual({
			outcome: "already_running",
			workflowId: WORKFLOW_ID,
			runId: "run_open",
			runKey: "sync_1:run_open",
		});
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
	});

	it("rethrows a failure whose outcome is unknown after one attempt, never retrying it (Decision 51)", async () => {
		// The server may have started the run before the answer was lost. A
		// retry could start a second, real run, so the caller decides.
		m.start.mockRejectedValue(new Error("deadline exceeded"));
		await expect(startAutomaticInstructionSync(POLL)).rejects.toThrow(
			"deadline exceeded",
		);
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("rethrows a describe that fails, so the caller treats it like a failed start", async () => {
		m.start.mockRejectedValue(alreadyStarted());
		m.describe.mockRejectedValue(new Error("service unavailable"));
		await expect(startAutomaticInstructionSync(POLL)).rejects.toThrow(
			"service unavailable",
		);
		expect(m.start).toHaveBeenCalledTimes(1);
	});
});
