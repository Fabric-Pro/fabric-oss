import { beforeEach, describe, expect, it, vi } from "vitest";

const acts = vi.hoisted(() => ({
	listRechunkSourcesActivity: vi.fn(),
	rechunkProjectSourceActivity: vi.fn(),
	recordProjectRechunkProgressActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => acts,
}));

import { projectRechunkWorkflow } from "../project-rechunk";

const input = {
	projectId: "proj-1",
	organizationId: "org-example",
	userId: "user-1",
	runId: "run-1",
	chunkingVersion: 3,
};

beforeEach(() => {
	vi.clearAllMocks();
	acts.recordProjectRechunkProgressActivity.mockResolvedValue(undefined);
});

describe("projectRechunkWorkflow", () => {
	it("re-chunks every source and completes, counting a failure without stopping", async () => {
		acts.listRechunkSourcesActivity.mockResolvedValue({
			contextIds: ["c1", "c2", "c3", "c4", "c5"],
			documentIds: ["d1"],
			current: true,
		});
		acts.rechunkProjectSourceActivity.mockImplementation(
			async ({ sourceId }: { sourceId: string }) =>
				sourceId === "c2"
					? { outcome: "failed", error: "provider down" }
					: sourceId === "c3"
						? { outcome: "skipped" }
						: { outcome: "rechunked" },
		);

		const result = await projectRechunkWorkflow(input);

		expect(result).toEqual({
			status: "COMPLETED",
			total: 6,
			done: 4,
			failed: 1,
			skipped: 1,
		});
		expect(acts.rechunkProjectSourceActivity).toHaveBeenCalledTimes(6);
		expect(acts.rechunkProjectSourceActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-example",
				chunkingVersion: 3,
				source: "document",
				sourceId: "d1",
			}),
		);
		expect(
			acts.recordProjectRechunkProgressActivity,
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				finalStatus: "COMPLETED",
				error: "provider down",
			}),
		);
	});

	it("stops as superseded when a newer change was saved before it began", async () => {
		acts.listRechunkSourcesActivity.mockResolvedValue({
			contextIds: [],
			documentIds: [],
			current: false,
		});
		const result = await projectRechunkWorkflow(input);
		expect(result.status).toBe("SUPERSEDED");
		expect(acts.rechunkProjectSourceActivity).not.toHaveBeenCalled();
	});

	it("stops after the batch in which a newer change is seen", async () => {
		acts.listRechunkSourcesActivity.mockResolvedValue({
			contextIds: Array.from({ length: 12 }, (_, i) => `c${i}`),
			documentIds: [],
			current: true,
		});
		acts.rechunkProjectSourceActivity.mockResolvedValue({
			outcome: "superseded",
		});
		const result = await projectRechunkWorkflow(input);
		expect(result.status).toBe("SUPERSEDED");
		expect(acts.rechunkProjectSourceActivity).toHaveBeenCalledTimes(4);
	});

	it("fails when every source failed", async () => {
		acts.listRechunkSourcesActivity.mockResolvedValue({
			contextIds: ["c1"],
			documentIds: [],
			current: true,
		});
		acts.rechunkProjectSourceActivity.mockResolvedValue({
			outcome: "failed",
			error: "boom",
		});
		const result = await projectRechunkWorkflow(input);
		expect(result.status).toBe("FAILED");
	});

	it("counts a source whose activity timed out as failed and still finishes the run", async () => {
		acts.listRechunkSourcesActivity.mockResolvedValue({
			contextIds: ["c1", "c2"],
			documentIds: [],
			current: true,
		});
		acts.rechunkProjectSourceActivity.mockImplementation(
			async ({ sourceId }: { sourceId: string }) => {
				if (sourceId === "c1") {
					throw new Error("activity Heartbeat timeout");
				}
				return { outcome: "rechunked" };
			},
		);
		const result = await projectRechunkWorkflow(input);
		expect(result).toMatchObject({
			status: "COMPLETED",
			done: 1,
			failed: 1,
		});
		expect(
			acts.recordProjectRechunkProgressActivity,
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				finalStatus: "COMPLETED",
				error: "activity Heartbeat timeout",
			}),
		);
	});
});
