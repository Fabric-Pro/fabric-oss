/**
 * The scheduled sweep asks this activity who to visit. With the QA feature off
 * the answer has to be "nobody".
 *
 * This is the half of the requirement that was missed. "Disabled ⇒ no pipeline
 * results are fetched or displayed" was read as a statement about the UI, and
 * the API gate delivered that: every procedure answers NOT_FOUND. But the
 * fifteen-minute sweep runs in the worker, which never consulted the flag — so a
 * deployment with the whole QA surface switched off still called the customer's
 * CI every quarter of an hour and wrote result rows nothing could show.
 *
 * The gate lives here rather than on the schedule for the reason every sibling
 * sweep gives: the schedule stays registered, so turning the flag on takes
 * effect on the next tick with no redeploy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.fn();
const mockIsEnabled = vi.fn();

vi.mock("@repo/database", () => ({
	listProjectsDueForPipelineSync: (...a: unknown[]) => mockList(...a),
	reapStaleAgenticRuns: vi.fn(),
}));

vi.mock("@repo/utils/feature-flag", () => ({
	isTestCasesEnabled: () => mockIsEnabled(),
}));

const { listProjectsDueForPipelineSyncActivity } = await import(
	"../list-projects-due-for-sync"
);

const DUE = [
	{
		projectId: "proj-1",
		organizationId: "org-1",
		userId: null,
		autoCreateBugsFromFailures: false,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mockList.mockResolvedValue(DUE);
});

describe("listProjectsDueForPipelineSyncActivity", () => {
	it("returns an empty due-list when the QA feature is off", async () => {
		mockIsEnabled.mockReturnValue(false);

		await expect(listProjectsDueForPipelineSyncActivity()).resolves.toEqual(
			[],
		);
	});

	it("does not even ask the database when the feature is off", async () => {
		// The assertion that matters. Returning [] after querying would still be
		// a query per tick; the point is that a switched-off deployment does no
		// work and makes no outbound call on this path at all.
		mockIsEnabled.mockReturnValue(false);

		await listProjectsDueForPipelineSyncActivity();

		expect(mockList).not.toHaveBeenCalled();
	});

	it("returns the due projects when the feature is on", async () => {
		mockIsEnabled.mockReturnValue(true);

		await expect(listProjectsDueForPipelineSyncActivity()).resolves.toEqual(
			DUE,
		);
	});

	it("passes the caller's limit through when the feature is on", async () => {
		mockIsEnabled.mockReturnValue(true);

		await listProjectsDueForPipelineSyncActivity({ limit: 7 });

		expect(mockList).toHaveBeenCalledWith({ limit: 7 });
	});
});
