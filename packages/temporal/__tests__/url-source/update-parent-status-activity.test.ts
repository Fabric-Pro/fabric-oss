/**
 * Tests for `updateParentStatusActivity`.
 *
 * Verifies the workflow's finalize step writes the right field set for both
 * COMPLETED and FAILED outcomes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: {
			update: vi.fn(),
		},
	},
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { db } from "@repo/database/prisma/client";
import { updateParentStatusActivity } from "../../src/activities/url-source/update-parent-status-activity";

const mockUpdate = db.projectContext.update as ReturnType<typeof vi.fn>;

describe("updateParentStatusActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdate.mockResolvedValue({});
	});

	it("writes COMPLETED with timestamps and clears any prior error", async () => {
		const now = new Date("2026-05-13T12:00:00Z");
		const next = new Date("2026-05-14T12:00:00Z");

		await updateParentStatusActivity({
			contextId: "ctx-1",
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: now,
			urlNextRefreshAt: next,
		});

		expect(mockUpdate).toHaveBeenCalledOnce();
		expect(mockUpdate.mock.calls[0][0]).toEqual({
			where: { id: "ctx-1" },
			data: {
				extractionStatus: "COMPLETED",
				extractionError: null,
				urlLastSyncedAt: now,
				urlNextRefreshAt: next,
				// Finalize always clears the in-flight workflowId so future
				// re-syncs aren't blocked by the resync CONFLICT guard and
				// the cancel procedure doesn't see a stale id.
				urlActiveWorkflowId: null,
			},
		});
	});

	it("writes FAILED with extractionError", async () => {
		await updateParentStatusActivity({
			contextId: "ctx-1",
			extractionStatus: "FAILED",
			extractionError: "robots.txt disallowed",
			urlLastSyncedAt: null,
			urlNextRefreshAt: null,
		});

		expect(mockUpdate.mock.calls[0][0]).toEqual({
			where: { id: "ctx-1" },
			data: {
				extractionStatus: "FAILED",
				extractionError: "robots.txt disallowed",
				urlLastSyncedAt: null,
				urlNextRefreshAt: null,
				urlActiveWorkflowId: null,
			},
		});
	});

	it("writes single-page content directly on the parent row", async () => {
		await updateParentStatusActivity({
			contextId: "ctx-1",
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date("2026-05-13T12:00:00Z"),
			urlNextRefreshAt: null,
			content: "# extracted markdown",
		});

		expect(mockUpdate.mock.calls[0][0].data.content).toBe(
			"# extracted markdown",
		);
	});
});
