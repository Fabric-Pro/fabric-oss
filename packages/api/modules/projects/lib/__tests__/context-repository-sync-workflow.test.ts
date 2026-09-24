/**
 * The Temporal side of the Living Memory repository sync as the API sees it
 * (design 2026-09-23 §5.2, §5.3.0 step 2, Fizzy #2657).
 *
 * What this pins: the workflow id literal and the start options (queue,
 * conflict policy, args, correlation memo) the workflow in `@repo/temporal`
 * must match — and, since the shared poll and the push webhook start the
 * same workflow for the same project from `@repo/temporal` (§11.1, Fizzy
 * #2673), that this id is the one `@repo/instructions/workflow-ids` builds
 * for them, so an automatic run and a "Sync now" collapse onto one id; that
 * only a duplicate-id refusal reads as "already running";
 * and the describe budget — each execution described by its exact run id,
 * 5 s each and 20 s in total, a failed or timed-out describe `unknown`,
 * never closed.
 */
import { contextRepositorySyncWorkflowId as sharedContextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getHandle: vi.fn(),
	getTemporalClient: vi.fn(),
	withCorrelationMemo: vi.fn((o: unknown) => o),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: m.getTemporalClient,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: m.withCorrelationMemo,
}));

import {
	contextRepositorySyncWorkflowId,
	describeContextSyncExecutions,
	isContextRepositorySyncRunning,
	startContextRepositorySync,
	workflowRunIdFromRunKey,
} from "../context-repository-sync-workflow";

const input = {
	projectId: "proj_1",
	organizationId: "org_1",
	trigger: "MANUAL" as const,
	requesterUserId: "user_1",
};

beforeEach(() => {
	vi.clearAllMocks();
	m.withCorrelationMemo.mockImplementation((o: unknown) => o);
	m.getTemporalClient.mockResolvedValue({
		workflow: { start: m.start, getHandle: m.getHandle },
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("contextRepositorySyncWorkflowId", () => {
	it("is one id per project, the literal the workflow must use", () => {
		expect(contextRepositorySyncWorkflowId("proj_1")).toBe(
			"context-repository-sync-proj_1",
		);
	});

	it("is the id the automatic starter and begin's describes use (@repo/instructions/workflow-ids)", () => {
		for (const projectId of ["proj_1", "cm0example0000000000000000"]) {
			expect(contextRepositorySyncWorkflowId(projectId)).toBe(
				sharedContextRepositorySyncWorkflowId(projectId),
			);
		}
	});
});

describe("startContextRepositorySync", () => {
	const expectedOptions = {
		taskQueue: "project-documents",
		workflowId: "context-repository-sync-proj_1",
		workflowIdConflictPolicy: "FAIL",
		args: [input],
	};

	it("starts the workflow by name, on project-documents, FAIL conflict policy, args=[input], through the correlation memo", async () => {
		m.start.mockResolvedValue(undefined);

		expect(await startContextRepositorySync(input)).toBe(true);
		expect(m.withCorrelationMemo).toHaveBeenCalledWith(expectedOptions);
		expect(m.start).toHaveBeenCalledWith(
			"projectContextRepositorySyncWorkflow",
			expectedOptions,
		);
	});

	it("answers false when Temporal refuses the duplicate id (already running)", async () => {
		const error = new Error("dup");
		error.name = "WorkflowExecutionAlreadyStartedError";
		m.start.mockRejectedValue(error);

		expect(await startContextRepositorySync(input)).toBe(false);
	});

	it("rethrows any other start failure", async () => {
		m.start.mockRejectedValue(new Error("temporal unreachable"));

		await expect(startContextRepositorySync(input)).rejects.toThrow(
			"temporal unreachable",
		);
	});
});

describe("isContextRepositorySyncRunning", () => {
	it("is true only for a RUNNING latest execution, and false when describe fails", async () => {
		m.getHandle.mockReturnValueOnce({
			describe: async () => ({ status: { name: "RUNNING" } }),
		});
		expect(await isContextRepositorySyncRunning("proj_1")).toBe(true);
		expect(m.getHandle).toHaveBeenCalledWith(
			"context-repository-sync-proj_1",
		);

		m.getHandle.mockReturnValueOnce({
			describe: async () => ({ status: { name: "COMPLETED" } }),
		});
		expect(await isContextRepositorySyncRunning("proj_1")).toBe(false);

		m.getHandle.mockReturnValueOnce({
			describe: async () => {
				throw new Error("no such workflow");
			},
		});
		expect(await isContextRepositorySyncRunning("proj_1")).toBe(false);
	});
});

describe("workflowRunIdFromRunKey", () => {
	it("takes the run id after `<syncId>:` and refuses any other shape", () => {
		expect(workflowRunIdFromRunKey("sync_1", "sync_1:run-a")).toBe("run-a");
		expect(workflowRunIdFromRunKey("sync_1", "sync_2:run-a")).toBeNull();
		expect(workflowRunIdFromRunKey("sync_1", "sync_1:")).toBeNull();
		expect(workflowRunIdFromRunKey("sync_1", "run-a")).toBeNull();
	});
});

describe("describeContextSyncExecutions (§5.3.0 step 2)", () => {
	function handles(
		byRunId: Record<string, () => Promise<{ status: { name: string } }>>,
	) {
		m.getHandle.mockImplementation(
			(_workflowId: string, runId: string) => ({
				describe:
					byRunId[runId] ??
					(async () => ({ status: { name: "RUNNING" } })),
			}),
		);
	}

	it("describes each receipt's exact execution and classifies it", async () => {
		const notFound = Object.assign(new Error("gone"), {
			name: "WorkflowNotFoundError",
		});
		handles({
			a: async () => ({ status: { name: "RUNNING" } }),
			b: async () => ({ status: { name: "TERMINATED" } }),
			c: async () => {
				throw notFound;
			},
			d: async () => {
				throw new Error("connection reset");
			},
			e: async () => ({ status: { name: "UNSPECIFIED" } }),
		});

		const states = await describeContextSyncExecutions({
			projectId: "proj_1",
			syncId: "sync_1",
			runKeys: ["a", "b", "c", "d", "e", "bad-key"].map((id) =>
				id === "bad-key" ? "other:bad" : `sync_1:${id}`,
			),
		});

		expect(Object.fromEntries(states)).toEqual({
			"sync_1:a": "running",
			"sync_1:b": "closed",
			"sync_1:c": "not-found",
			"sync_1:d": "unknown",
			"sync_1:e": "unknown",
			"other:bad": "unknown",
		});
		expect(m.getHandle).toHaveBeenCalledWith(
			"context-repository-sync-proj_1",
			"b",
		);
	});

	it("treats a describe that outlives its 5-second budget as unknown, never closed", async () => {
		vi.useFakeTimers();
		handles({ slow: () => new Promise(() => {}) });

		const pending = describeContextSyncExecutions({
			projectId: "proj_1",
			syncId: "sync_1",
			runKeys: ["sync_1:slow"],
		});
		await vi.advanceTimersByTimeAsync(5_000);

		expect(Object.fromEntries(await pending)).toEqual({
			"sync_1:slow": "unknown",
		});
	});

	it("stops describing once 20 seconds are spent: the rest are unknown", async () => {
		let clock = 0;
		handles({
			a: async () => {
				clock += 19_000;
				return { status: { name: "COMPLETED" } };
			},
			b: async () => {
				clock += 2_000;
				return { status: { name: "COMPLETED" } };
			},
		});

		const states = await describeContextSyncExecutions({
			projectId: "proj_1",
			syncId: "sync_1",
			runKeys: ["sync_1:a", "sync_1:b", "sync_1:c"],
			now: () => clock,
		});

		expect(Object.fromEntries(states)).toEqual({
			"sync_1:a": "closed",
			"sync_1:b": "closed",
			"sync_1:c": "unknown",
		});
		expect(m.getHandle).toHaveBeenCalledTimes(2);
	});

	it("reads every receipt as unknown when no Temporal client can be had", async () => {
		m.getTemporalClient.mockRejectedValue(new Error("no connection"));

		const states = await describeContextSyncExecutions({
			projectId: "proj_1",
			syncId: "sync_1",
			runKeys: ["sync_1:a"],
		});

		expect(Object.fromEntries(states)).toEqual({ "sync_1:a": "unknown" });
	});
});
