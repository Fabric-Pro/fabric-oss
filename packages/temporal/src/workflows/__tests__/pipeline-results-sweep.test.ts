/**
 * Workflow-level tests for `syncAllPipelineResultsWorkflow` — the scheduled
 * sweep that pulls CI results without anyone pressing "Sync now".
 *
 * The property that actually matters, and the reason this file exists: the
 * sweep starts the SAME per-project workflow the manual button starts, under
 * the SAME workflow id, so a scheduled tick colliding with a human press
 * COLLAPSES instead of duplicating provider calls. That collapse shows up as a
 * `WorkflowExecutionAlreadyStartedError` from `startChild`, which is a success
 * signal here, not a failure — get that backwards and every tick that overlaps
 * a manual sync fails the sweep.
 *
 * Harness follows the other light workflow tests in this package: mock
 * `@temporalio/workflow` so `proxyActivities` returns plain stubs and
 * `startChild` is controllable, then call the workflow as a normal async
 * function.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	listProjectsDueForPipelineSyncActivity: vi.fn(),
	reapStaleAgenticRunsActivity: vi.fn(),
}));

const startChildMock = vi.hoisted(() => vi.fn());

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => activityStubs,
	patched: () => true,
	startChild: (...args: unknown[]) => startChildMock(...args),
	ParentClosePolicy: { ABANDON: "ABANDON" },
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real class, so `instanceof` in the workflow behaves as it does in
// production. Mocking it would let a wrong `instanceof` pass here and fail live.
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { syncAllPipelineResultsWorkflow } from "../pipeline-results-sync";

function project(id: string, autoBug = false) {
	return {
		projectId: id,
		organizationId: "org-1",
		userId: "user-1",
		autoCreateBugsFromFailures: autoBug,
	};
}

function alreadyStarted() {
	return new WorkflowExecutionAlreadyStartedError(
		"already started",
		"pipeline-results-sync-p1",
		"syncPipelineResultsWorkflow",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.reapStaleAgenticRunsActivity.mockResolvedValue({
		reaped: 0,
	});
	startChildMock.mockResolvedValue({ workflowId: "child" });
});

describe("syncAllPipelineResultsWorkflow", () => {
	it("starts one per-project sync for each project returned", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("p1"),
			project("p2"),
		]);

		const result = await syncAllPipelineResultsWorkflow();

		expect(result).toEqual({
			considered: 2,
			started: 2,
			alreadyRunning: 0,
		});
		expect(startChildMock).toHaveBeenCalledTimes(2);
		expect(
			activityStubs.reapStaleAgenticRunsActivity,
		).toHaveBeenCalledOnce();
	});

	it("uses the SAME workflow id as the manual Sync now, so the two collapse", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("proj-abc"),
		]);

		await syncAllPipelineResultsWorkflow();

		const [, options] = startChildMock.mock.calls[0];
		// This literal is duplicated in the sync procedure. If either side
		// changes, the collapse silently stops working and both a tick and a
		// button press hit the provider — so it is pinned on both sides.
		expect(options.workflowId).toBe("pipeline-results-sync-proj-abc");
		expect(options.parentClosePolicy).toBe("ABANDON");
	});

	it("counts an already-running project instead of failing the sweep", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("p1"),
			project("p2"),
			project("p3"),
		]);
		startChildMock
			.mockResolvedValueOnce({ workflowId: "c1" })
			.mockRejectedValueOnce(alreadyStarted())
			.mockResolvedValueOnce({ workflowId: "c3" });

		const result = await syncAllPipelineResultsWorkflow();

		expect(result).toEqual({
			considered: 3,
			started: 2,
			alreadyRunning: 1,
		});
	});

	it("keeps sweeping the remaining projects after a collision", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("p1"),
			project("p2"),
		]);
		startChildMock
			.mockRejectedValueOnce(alreadyStarted())
			.mockResolvedValueOnce({ workflowId: "c2" });

		await syncAllPipelineResultsWorkflow();

		// The second project must still be attempted — an early return here
		// would mean one busy project stops everyone else from ever syncing.
		expect(startChildMock).toHaveBeenCalledTimes(2);
	});

	it("propagates a genuine failure rather than reporting a clean sweep", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("p1"),
		]);
		startChildMock.mockRejectedValueOnce(new Error("temporal is down"));

		await expect(syncAllPipelineResultsWorkflow()).rejects.toThrow(
			"temporal is down",
		);
	});

	it("carries each project's own auto-bug setting to its child", async () => {
		// Getting this wrong would open bugs for a project that opted out — the
		// setting is per project and the sweep has no actor to fall back on.
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue([
			project("p1", true),
			project("p2", false),
		]);

		await syncAllPipelineResultsWorkflow();

		expect(startChildMock.mock.calls[0][1].args[0]).toMatchObject({
			projectId: "p1",
			autoCreateBugsFromFailures: true,
			// No actor: a scheduled sweep is not a person.
			userId: null,
		});
		expect(startChildMock.mock.calls[1][1].args[0]).toMatchObject({
			projectId: "p2",
			autoCreateBugsFromFailures: false,
		});
	});

	it("does nothing when no project qualifies", async () => {
		activityStubs.listProjectsDueForPipelineSyncActivity.mockResolvedValue(
			[],
		);

		const result = await syncAllPipelineResultsWorkflow();

		expect(result).toEqual({
			considered: 0,
			started: 0,
			alreadyRunning: 0,
		});
		expect(startChildMock).not.toHaveBeenCalled();
	});
});
