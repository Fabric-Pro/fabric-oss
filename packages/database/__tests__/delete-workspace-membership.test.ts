import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workspaceFindFirst: vi.fn(),
	workspaceDelete: vi.fn(),
	memberFindFirst: vi.fn(),
	administratorFindFirst: vi.fn(),
	contributorFindFirst: vi.fn(),
	stakeholderFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		workspace: {
			findFirst: mocks.workspaceFindFirst,
			delete: mocks.workspaceDelete,
		},
		member: { findFirst: mocks.memberFindFirst },
		workspaceAdministrator: { findFirst: mocks.administratorFindFirst },
		workspaceContributor: { findFirst: mocks.contributorFindFirst },
		workspaceStakeholder: { findFirst: mocks.stakeholderFindFirst },
	},
}));

import { deleteWorkspace } from "../prisma/queries/workspaces/workspaces";

const workspace = {
	id: "ws-example",
	userId: "creator",
	organizationId: "example-org",
	type: "CUSTOM",
};

describe("deleteWorkspace", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workspaceFindFirst.mockResolvedValue(workspace);
		mocks.memberFindFirst.mockResolvedValue({ id: "member-example" });
		mocks.administratorFindFirst.mockResolvedValue(null);
		mocks.contributorFindFirst.mockResolvedValue(null);
		mocks.stakeholderFindFirst.mockResolvedValue(null);
		mocks.workspaceDelete.mockResolvedValue({ id: workspace.id });
	});

	it("lets a live owner delete with every checked row and membership clause in the filter", async () => {
		await expect(deleteWorkspace(workspace.id, "creator")).resolves.toEqual(
			{
				id: workspace.id,
			},
		);
		expect(mocks.memberFindFirst).toHaveBeenCalledWith({
			where: { organizationId: "example-org", userId: "creator" },
			select: { id: true },
		});
		expect(mocks.workspaceDelete).toHaveBeenCalledWith({
			where: {
				id: workspace.id,
				userId: "creator",
				organizationId: "example-org",
				type: "CUSTOM",
				organization: {
					members: { some: { userId: "creator" } },
				},
			},
		});
	});

	it("refuses the creator after their organization membership is removed", async () => {
		mocks.memberFindFirst.mockResolvedValue(null);
		await expect(deleteWorkspace(workspace.id, "creator")).rejects.toThrow(
			"Only the workspace owner can delete it",
		);
		expect(mocks.workspaceDelete).not.toHaveBeenCalled();
	});

	it("refuses a member who is not the workspace owner", async () => {
		await expect(
			deleteWorkspace(workspace.id, "member-other"),
		).rejects.toThrow("Only the workspace owner can delete it");
		expect(mocks.workspaceDelete).not.toHaveBeenCalled();
	});

	it("refuses a custom workspace without an organization", async () => {
		mocks.workspaceFindFirst.mockResolvedValue({
			...workspace,
			organizationId: null,
		});
		await expect(deleteWorkspace(workspace.id, "creator")).rejects.toThrow(
			"Only the workspace owner can delete it",
		);
		expect(mocks.workspaceDelete).not.toHaveBeenCalled();
	});

	it("fails closed when membership cannot be read", async () => {
		mocks.memberFindFirst.mockRejectedValue(
			new Error("Membership unavailable"),
		);
		await expect(deleteWorkspace(workspace.id, "creator")).rejects.toThrow(
			"Membership unavailable",
		);
		expect(mocks.workspaceDelete).not.toHaveBeenCalled();
	});

	it("surfaces a database delete error rather than reporting success", async () => {
		mocks.workspaceDelete.mockRejectedValue(new Error("Record not found"));
		await expect(deleteWorkspace(workspace.id, "creator")).rejects.toThrow(
			"Record not found",
		);
		expect(mocks.workspaceDelete).toHaveBeenCalledTimes(1);
	});

	it("still refuses personal workspaces", async () => {
		mocks.workspaceFindFirst.mockResolvedValue({
			...workspace,
			type: "PERSONAL",
		});
		await expect(deleteWorkspace(workspace.id, "creator")).rejects.toThrow(
			"Personal workspaces cannot be deleted",
		);
		expect(mocks.workspaceDelete).not.toHaveBeenCalled();
	});
});
