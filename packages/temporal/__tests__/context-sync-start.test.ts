/**
 * The Living Memory sync's automatic starter (design 2026-09-23 §11.1,
 * Fizzy #2673): the `context` subject's `startRun`. What this pins: the
 * workflow type, queue, id and conflict policy are the ones the API's
 * "Sync now" uses (`packages/api/modules/projects/lib/__tests__/
 * context-repository-sync-workflow.test.ts` pins the same literals), so an
 * automatic and a manual start for one project collapse onto one run; the
 * input carries no requester and no credential; the caller's correlation
 * memo is applied; an open run is `already_running` with its own run key;
 * and one attempt only.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/context-sync-start.test.ts
 */
import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
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

import { startAutomaticContextSync } from "../src/activities/lib/context-sync-start";
import type { RepositorySyncStartResult } from "../src/activities/lib/instruction-sync-start";
import type { AutomaticContextSyncTrigger } from "../src/lib/context-sync-types";
import { projectContextRepositorySyncWorkflow } from "../src/workflows/project-context-repository-sync";

/** The API's literals for "Sync now" (context-repository-sync-workflow.ts). */
const WORKFLOW_TYPE = "projectContextRepositorySyncWorkflow";
const TASK_QUEUE = "project-documents";
const WORKFLOW_ID = "context-repository-sync-proj_1";
const EXPECTED = { syncId: "sync_1", generation: 3 };
/** What the poll passes: the claimed row's id, and that row as `expected`. */
const POLL = {
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
		WORKFLOW_TYPE,
	);
}

describe("startAutomaticContextSync (§11.1)", () => {
	it("takes only the automatic triggers and reports the run it reached", () => {
		expectTypeOf<
			Parameters<typeof startAutomaticContextSync>[0]["trigger"]
		>().toEqualTypeOf<AutomaticContextSyncTrigger>();
		expectTypeOf<AutomaticContextSyncTrigger>().toEqualTypeOf<
			"POLL" | "WEBHOOK"
		>();
		expectTypeOf<
			Awaited<ReturnType<typeof startAutomaticContextSync>>
		>().toEqualTypeOf<RepositorySyncStartResult>();
	});

	it("builds the id the workflow's own describes use, the literal the API starts", () => {
		expect(contextRepositorySyncWorkflowId("proj_1")).toBe(WORKFLOW_ID);
	});

	it("starts by the name the workflow is registered under", () => {
		expect(projectContextRepositorySyncWorkflow.name).toBe(WORKFLOW_TYPE);
	});

	it("starts the project's sync workflow with the API's type, queue, id and conflict policy, carrying only the ids, the trigger and the expected row, and reports the new run", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });

		await expect(startAutomaticContextSync(POLL)).resolves.toEqual({
			outcome: "started",
			workflowId: WORKFLOW_ID,
			runId: "run_1",
		});

		expect(m.start).toHaveBeenCalledTimes(1);
		const [type, options] = m.start.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(type).toBe(WORKFLOW_TYPE);
		// Exactly these options: no reuse policy (the id is per project and
		// every run reuses it), and no memo without a decorator.
		expect(options).toEqual({
			taskQueue: TASK_QUEUE,
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
		});
		// No requester: the run acts as the configuration's member, read by
		// `begin`. No credential of any kind: the run resolves its own.
		const [input] = options.args as [Record<string, unknown>];
		expect(Object.keys(input).sort()).toEqual([
			"expected",
			"organizationId",
			"projectId",
			"trigger",
		]);
		expect(JSON.stringify(options)).not.toMatch(/token|secret|password/i);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("sends no expected row when the caller passes none", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });
		await startAutomaticContextSync({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
		});
		expect(m.start.mock.calls[0]?.[1].args[0]).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "POLL",
		});
	});

	it("applies the caller's decorator, as the webhook does for its correlation memo", async () => {
		m.start.mockResolvedValue({ firstExecutionRunId: "run_1" });
		function withMemo<T extends object>(options: T): T {
			return { ...options, memo: { correlationId: "corr_1" } };
		}

		await startAutomaticContextSync(
			{ ...POLL, trigger: "WEBHOOK" },
			withMemo,
		);

		expect(m.start).toHaveBeenCalledWith(WORKFLOW_TYPE, {
			taskQueue: TASK_QUEUE,
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
		});
	});

	it("reports an open run — a Sync now included — as already running, with that run's id from describe, and never starts twice", async () => {
		m.start.mockRejectedValue(alreadyStarted());
		m.describe.mockResolvedValue({ runId: "run_open" });

		await expect(startAutomaticContextSync(POLL)).resolves.toEqual({
			outcome: "already_running",
			workflowId: WORKFLOW_ID,
			runId: "run_open",
		});
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
	});

	it("rethrows a failure whose outcome is unknown after one attempt, never retrying it", async () => {
		m.start.mockRejectedValue(new Error("deadline exceeded"));
		await expect(startAutomaticContextSync(POLL)).rejects.toThrow(
			"deadline exceeded",
		);
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("rethrows a describe that fails, so the caller treats it like a failed start", async () => {
		m.start.mockRejectedValue(alreadyStarted());
		m.describe.mockRejectedValue(new Error("service unavailable"));
		await expect(startAutomaticContextSync(POLL)).rejects.toThrow(
			"service unavailable",
		);
		expect(m.start).toHaveBeenCalledTimes(1);
	});
});
