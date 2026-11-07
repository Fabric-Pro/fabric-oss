import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execution: vi.fn(), projects: vi.fn() }));
vi.mock("@repo/database", () => ({
	getTemplateInstanceExecution: mocks.execution,
	db: { project: { findMany: mocks.projects } },
}));

import type { Notification } from "@repo/database";
import { filterByCurrentAccess } from "../access-filter";

const report = {
	id: "example-notification",
	type: "REPORT_COMPLETED",
	organizationId: "example-org",
	projectId: null,
	payload: { executionId: "example-run" },
} as unknown as Notification;
beforeEach(() => vi.clearAllMocks());
describe("report notification audience", () => {
	it("hides revoked company-wide report access even without a project", async () => {
		mocks.execution.mockResolvedValue(null);
		expect(
			await filterByCurrentAccess([report], "example-recipient"),
		).toEqual([]);
		expect(mocks.execution).toHaveBeenCalledWith("example-run", {
			userId: "example-recipient",
			organizationId: "example-org",
		});
	});
	it("rechecks current access and cancellation, caching repeated execution lookups", async () => {
		mocks.execution.mockResolvedValue({ status: "COMPLETED" });
		expect(
			await filterByCurrentAccess(
				[report, { ...report, id: "example-notification-2" }],
				"example-recipient",
			),
		).toHaveLength(2);
		expect(mocks.execution).toHaveBeenCalledTimes(1);
		mocks.execution.mockResolvedValue({ status: "CANCELLED" });
		expect(
			await filterByCurrentAccess([report], "example-recipient"),
		).toEqual([]);
	});
});
