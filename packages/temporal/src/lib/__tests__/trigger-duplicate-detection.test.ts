/**
 * Tests for `triggerDuplicateDetection` — the fire-and-forget client trigger
 * that enqueues the background `detectDuplicates` workflow.
 *
 * Contract:
 *   - no-op (returns null, starts nothing) when there are no target ids,
 *   - starts `detectDuplicatesWorkflow` on the `ai-chat` queue with deduped
 *     target ids when Temporal is available,
 *   - returns null (never throws) when Temporal is unavailable or start fails —
 *     enqueue failure must never break the calling create/approve flow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStart, mockGetClient, mockIsAvailable } = vi.hoisted(() => ({
	mockStart: vi.fn(),
	mockGetClient: vi.fn(),
	mockIsAvailable: vi.fn(),
}));

// Path is relative to THIS test file (src/lib/__tests__/) and must resolve to
// the same module the helper imports (`../client` from src/lib → src/client).
vi.mock("../../client", () => ({
	getTemporalClient: mockGetClient,
	isTemporalAvailable: mockIsAvailable,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { triggerDuplicateDetection } from "../trigger-duplicate-detection";

const baseParams = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockIsAvailable.mockResolvedValue(true);
	mockStart.mockResolvedValue({ workflowId: "dup-detect-proj-1-123" });
	mockGetClient.mockResolvedValue({ workflow: { start: mockStart } });
});

describe("triggerDuplicateDetection", () => {
	it("does nothing and returns null when there are no target ids", async () => {
		const result = await triggerDuplicateDetection({
			...baseParams,
			targetStoryIds: [],
		});
		expect(result).toBeNull();
		expect(mockIsAvailable).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("starts detectDuplicatesWorkflow on the ai-chat queue with deduped targets", async () => {
		const result = await triggerDuplicateDetection({
			...baseParams,
			targetStoryIds: ["s1", "s2", "s1"],
		});

		expect(mockStart).toHaveBeenCalledTimes(1);
		const [workflowName, opts] = mockStart.mock.calls[0] as [
			string,
			{ taskQueue: string; workflowId: string; args: unknown[] },
		];
		expect(workflowName).toBe("detectDuplicatesWorkflow");
		expect(opts.taskQueue).toBe("ai-chat");
		expect(opts.workflowId).toMatch(/^dup-detect-proj-1-/);
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			targetStoryIds: ["s1", "s2"],
		});
		expect(result).toEqual({ workflowId: "dup-detect-proj-1-123" });
	});

	it("returns null (no start) when Temporal is unavailable", async () => {
		mockIsAvailable.mockResolvedValue(false);
		const result = await triggerDuplicateDetection({
			...baseParams,
			targetStoryIds: ["s1"],
		});
		expect(result).toBeNull();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("returns null (never throws) when the workflow start fails", async () => {
		mockStart.mockRejectedValue(new Error("temporal down"));
		const result = await triggerDuplicateDetection({
			...baseParams,
			targetStoryIds: ["s1"],
		});
		expect(result).toBeNull();
	});
});
