import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	clearUserOrgSessionsActivity: vi.fn(),
	deleteUserProjectsInOrgActivity: vi.fn(),
	deleteUserWorkflowsInOrgActivity: vi.fn(),
	deleteUserWorkspacesInOrgActivity: vi.fn(),
	removeUserWorkspaceMembershipsInOrgActivity: vi.fn(),
	removeUserProjectMembershipsInOrgActivity: vi.fn(),
	deleteUserMcpConfigsInOrgActivity: vi.fn(),
	deleteUserAgentTemplateInstancesInOrgActivity: vi.fn(),
	deleteUserChatsInOrgActivity: vi.fn(),
	deleteProjectAttachmentsFromStorageActivity: vi.fn(),
}));
const wf = vi.hoisted(() => ({ patched: vi.fn() }));

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: (...a: unknown[]) => wf.patched(...a),
	proxyActivities: vi.fn(() => activityStubs),
}));

import { memberCascadeDeleteWorkflow } from "../member-cascade-delete";

beforeEach(() => {
	vi.clearAllMocks();
	wf.patched.mockReturnValue(true);
	activityStubs.clearUserOrgSessionsActivity.mockResolvedValue({
		clearedCount: 0,
		errors: [],
	});
	activityStubs.deleteUserProjectsInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		deletedProjectIds: [],
		errors: [],
	});
	activityStubs.deleteUserWorkflowsInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		errors: [],
	});
	activityStubs.deleteUserWorkspacesInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		errors: [],
	});
	activityStubs.removeUserWorkspaceMembershipsInOrgActivity.mockResolvedValue(
		{ deletedCount: 0, errors: [] },
	);
	activityStubs.removeUserProjectMembershipsInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		errors: [],
	});
	activityStubs.deleteUserMcpConfigsInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		errors: [],
	});
	activityStubs.deleteUserAgentTemplateInstancesInOrgActivity.mockResolvedValue(
		{ deletedCount: 0, errors: [] },
	);
	activityStubs.deleteUserChatsInOrgActivity.mockResolvedValue({
		deletedCount: 0,
		errors: [],
	});
	activityStubs.deleteProjectAttachmentsFromStorageActivity.mockResolvedValue(
		{ deleted: 0, pages: 1 },
	);
});

describe("memberCascadeDeleteWorkflow — attachment cleanup wiring", () => {
	it("cleans up R2 objects once per deleted project, after deletion, gated by the patch id", async () => {
		activityStubs.deleteUserProjectsInOrgActivity.mockResolvedValue({
			deletedCount: 2,
			deletedProjectIds: ["p1", "p2"],
			errors: [],
		});
		const out = await memberCascadeDeleteWorkflow({
			userId: "u1",
			organizationId: "o1",
		});
		expect(out.success).toBe(true);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenCalledTimes(2);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenNthCalledWith(1, { projectId: "p1" });
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenNthCalledWith(2, { projectId: "p2" });
		expect(wf.patched).toHaveBeenCalledWith(
			"attachment-r2-cleanup-on-member-cascade",
		);
		// cleanup runs AFTER the project-deletion activity
		expect(
			activityStubs.deleteUserProjectsInOrgActivity.mock
				.invocationCallOrder[0],
		).toBeLessThan(
			activityStubs.deleteProjectAttachmentsFromStorageActivity.mock
				.invocationCallOrder[0],
		);
	});

	it("does NOT clean up when the patch is inactive (replay of pre-change history)", async () => {
		wf.patched.mockReturnValue(false);
		activityStubs.deleteUserProjectsInOrgActivity.mockResolvedValue({
			deletedCount: 1,
			deletedProjectIds: ["p1"],
			errors: [],
		});
		await memberCascadeDeleteWorkflow({
			userId: "u1",
			organizationId: "o1",
		});
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).not.toHaveBeenCalled();
	});

	it("swallows a cleanup failure — cascade still succeeds and errors stays empty", async () => {
		activityStubs.deleteUserProjectsInOrgActivity.mockResolvedValue({
			deletedCount: 1,
			deletedProjectIds: ["p1"],
			errors: [],
		});
		activityStubs.deleteProjectAttachmentsFromStorageActivity.mockRejectedValue(
			new Error("bucket down"),
		);
		const out = await memberCascadeDeleteWorkflow({
			userId: "u1",
			organizationId: "o1",
		});
		expect(out.success).toBe(true);
		expect(out.errors).toEqual([]);
	});

	it("makes no cleanup call when no projects were deleted", async () => {
		const out = await memberCascadeDeleteWorkflow({
			userId: "u1",
			organizationId: "o1",
		});
		expect(out.success).toBe(true);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).not.toHaveBeenCalled();
	});
});
