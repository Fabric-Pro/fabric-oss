/**
 * `begin`'s describe phase (design 2026-09-23 §5.3.0 step 2): each unfinished
 * predecessor's EXACT execution, 5 seconds each and 20 in all, and anything
 * short of a clear answer is `unknown` — never closed. The cases mirror the
 * API twin's (`packages/api/modules/projects/lib/__tests__/context-repository-sync-workflow.test.ts`).
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/activities/lib/__tests__/context-sync-describe.test.ts
 */
import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getHandle: vi.fn(),
	getTemporalClient: vi.fn(),
}));

vi.mock("../../../client", () => ({
	getTemporalClient: m.getTemporalClient,
}));

import {
	describeContextSyncExecutions,
	workflowRunIdFromRunKey,
} from "../context-sync-describe";

function handles(
	byRunId: Record<string, () => Promise<{ status: { name: string } }>>,
) {
	m.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: m.getHandle },
	});
	m.getHandle.mockImplementation((_workflowId: string, runId: string) => ({
		describe:
			byRunId[runId] ?? (async () => ({ status: { name: "RUNNING" } })),
	}));
}

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("contextRepositorySyncWorkflowId", () => {
	it("is the literal the API starts the workflow under", () => {
		// packages/api/modules/projects/lib/context-repository-sync-workflow.ts
		// holds a copy of this literal; the two must stay equal.
		expect(contextRepositorySyncWorkflowId("proj_1")).toBe(
			"context-repository-sync-proj_1",
		);
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

describe("describeContextSyncExecutions", () => {
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

	it("asks nothing when there is nothing to describe", async () => {
		const states = await describeContextSyncExecutions({
			projectId: "proj_1",
			syncId: "sync_1",
			runKeys: [],
		});

		expect(states.size).toBe(0);
		expect(m.getTemporalClient).not.toHaveBeenCalled();
	});
});
