import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getWorkspaceAccessContext: vi.fn(),
	canManageWorkspace: vi.fn(),
	updateWorkspace: vi.fn(),
	archiveWorkspace: vi.fn(),
	reactivateWorkspace: vi.fn(),
	deleteWorkspace: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getWorkspaceAccessContext: mocks.getWorkspaceAccessContext,
	canManageWorkspace: mocks.canManageWorkspace,
	updateWorkspace: mocks.updateWorkspace,
	archiveWorkspace: mocks.archiveWorkspace,
	reactivateWorkspace: mocks.reactivateWorkspace,
	deleteWorkspace: mocks.deleteWorkspace,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		Permissions: { WORKSPACE_UPDATE: "workspace:update" },
		requirePermission: () => vi.fn(),
		tenantProtectedProcedure: chainable,
	};
});

import {
	archiveWorkspaceProcedure,
	deleteWorkspaceProcedure,
	reactivateWorkspaceProcedure,
	updateWorkspaceProcedure,
} from "../update-workspace";

type ProcedureHandler = (args: {
	input: { workspaceId: string };
	context: {
		user: { id: string };
		tenantContext: { organizationId: string | null };
	};
}) => Promise<unknown>;

const unwrap = (procedure: unknown) =>
	(procedure as { _handler: ProcedureHandler })._handler;

const handler = unwrap(deleteWorkspaceProcedure);

const input = { workspaceId: "ws-example" };

const mutationCases = [
	{
		name: "update",
		handler: unwrap(updateWorkspaceProcedure),
		query: mocks.updateWorkspace,
	},
	{
		name: "archive",
		handler: unwrap(archiveWorkspaceProcedure),
		query: mocks.archiveWorkspace,
	},
	{
		name: "reactivate",
		handler: unwrap(reactivateWorkspaceProcedure),
		query: mocks.reactivateWorkspace,
	},
];

describe.each(mutationCases)(
	"$name workspace procedure",
	({ handler, query }) => {
		beforeEach(() => {
			vi.clearAllMocks();
			mocks.canManageWorkspace.mockResolvedValue(true);
			mocks.getWorkspaceAccessContext.mockResolvedValue({
				organizationId: "example-org",
			});
			query.mockResolvedValue({
				id: input.workspaceId,
				name: "Example Workspace",
				description: null,
				documentLimit: 20,
				status: "ACTIVE",
				updatedAt: new Date("2026-10-31T00:00:00.000Z"),
			});
		});

		it.each(["other-org", null])(
			"refuses a caller acting in %s before the write",
			async (organizationId) => {
				await expect(
					handler({
						input,
						context: {
							user: { id: "creator" },
							tenantContext: { organizationId },
						},
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(query).not.toHaveBeenCalled();
			},
		);

		it("permits a member acting in the workspace organization", async () => {
			await expect(
				handler({
					input,
					context: {
						user: { id: "creator" },
						tenantContext: { organizationId: "example-org" },
					},
				}),
			).resolves.toMatchObject({ id: input.workspaceId });
			expect(query).toHaveBeenCalledTimes(1);
		});
	},
);

describe("deleteWorkspaceProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: "example-org",
		});
		mocks.deleteWorkspace.mockResolvedValue({ id: input.workspaceId });
	});

	it("deletes in the workspace's active organization", async () => {
		await expect(
			handler({
				input,
				context: {
					user: { id: "creator" },
					tenantContext: { organizationId: "example-org" },
				},
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.deleteWorkspace).toHaveBeenCalledWith(
			"ws-example",
			"creator",
		);
	});

	it.each(["other-org", null])(
		"refuses an active organization of %s",
		async (organizationId) => {
			await expect(
				handler({
					input,
					context: {
						user: { id: "creator" },
						tenantContext: { organizationId },
					},
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
		},
	);

	it("gives an inaccessible workspace the same response as another organization", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue(null);
		await expect(
			handler({
				input,
				context: {
					user: { id: "creator" },
					tenantContext: { organizationId: "example-org" },
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
	});

	it("refuses a workspace without an organization in a null tenant context", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: null,
		});
		await expect(
			handler({
				input,
				context: {
					user: { id: "creator" },
					tenantContext: { organizationId: null },
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
	});

	it("fails closed when workspace access cannot be read", async () => {
		mocks.getWorkspaceAccessContext.mockRejectedValue(
			new Error("Read unavailable"),
		);
		await expect(
			handler({
				input,
				context: {
					user: { id: "creator" },
					tenantContext: { organizationId: "example-org" },
				},
			}),
		).rejects.toThrow("Read unavailable");
		expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
	});
});
