/**
 * A summary run every ChatGPT plan stayed spent for (Fizzy #2770) is recorded
 * FAILED like any other, but raises no SEV-2 incident: nothing is broken, and
 * the next daily scan retries it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	createIncidentNotification: vi.fn(),
	failContextSummary: vi.fn(),
}));

vi.mock("@repo/database", () => dbMocks);
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifySummaryFailureActivity } from "../notify-summary-failure";

const INPUT = {
	summaryId: "sum-1",
	projectId: "proj-1",
	tenancy: { userId: null, organizationId: "org-1" },
	error: "Every ChatGPT plan is spent.",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("notifySummaryFailureActivity", () => {
	it("raises an incident for a real failure", async () => {
		await notifySummaryFailureActivity(INPUT);

		expect(dbMocks.failContextSummary).toHaveBeenCalledWith({
			id: "sum-1",
			error: INPUT.error,
		});
		expect(dbMocks.createIncidentNotification).toHaveBeenCalledTimes(1);
	});

	it("records a spent plan without an incident", async () => {
		await notifySummaryFailureActivity({ ...INPUT, planSpent: true });

		expect(dbMocks.failContextSummary).toHaveBeenCalledWith({
			id: "sum-1",
			error: INPUT.error,
		});
		expect(dbMocks.createIncidentNotification).not.toHaveBeenCalled();
	});
});
