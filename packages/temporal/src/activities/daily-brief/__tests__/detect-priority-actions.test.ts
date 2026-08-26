import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, getLatestProjectScanMock, listArchitectureDecisionsMock } =
	vi.hoisted(() => ({
		dbMock: {
			projectStoryStatus: { findMany: vi.fn() },
			scanFinding: { count: vi.fn() },
		},
		getLatestProjectScanMock: vi.fn(),
		listArchitectureDecisionsMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	getLatestProjectScan: getLatestProjectScanMock,
	listArchitectureDecisions: listArchitectureDecisionsMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { detectPriorityActionsActivity } from "../detect-priority-actions";

describe("detectPriorityActionsActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMock.projectStoryStatus.findMany.mockResolvedValue([]);
		dbMock.scanFinding.count.mockResolvedValue(2);
		getLatestProjectScanMock.mockResolvedValue({
			id: "scan-1",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			completedAt: new Date("2026-08-01T01:00:00.000Z"),
		});
		listArchitectureDecisionsMock.mockResolvedValue({
			items: [],
			total: 0,
		});
	});

	it("scopes the live security finding count through the project tenant", async () => {
		await detectPriorityActionsActivity({
			projectId: "project-1",
			organizationId: "org-host",
		});

		expect(dbMock.scanFinding.count).toHaveBeenCalledWith({
			where: {
				scanId: "scan-1",
				projectId: "project-1",
				project: { organizationId: "org-host" },
				category: "SECURITY",
				status: "OPEN",
				severity: { in: ["CRITICAL", "HIGH"] },
			},
		});
	});
});
