/**
 * The source of the project's org-member picker (Fizzy #1986, FR6-FR7). It
 * lists colleagues' email addresses, so it must stay behind the permission that
 * can act on them, and it must not offer anyone who cannot be invited.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	requireProjectPermission: vi.fn((..._args: unknown[]) => ({})),
	hasProjectAccess: vi.fn(),
	projectFindUnique: vi.fn(),
	memberFindMany: vi.fn(),
	invitationFindMany: vi.fn(),
	userFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectMember: { findMany: mocks.memberFindMany },
		projectInvitation: { findMany: mocks.invitationFindMany },
		user: { findMany: mocks.userFindMany },
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handlers.getEligible = fn;
			return fn;
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: mocks.requireProjectPermission,
		resolveOrganizationId: (id: string) => id,
		Permissions: {
			PROJECT_MEMBERS_READ: "project:members:read",
			PROJECT_MEMBERS_MANAGE: "project:members:manage",
		},
	};
});

import "../get-eligible-users";

const permissionAtImport = mocks.requireProjectPermission.mock.calls[0]?.[0];

function run(search?: string) {
	return mocks.handlers.getEligible?.({
		context: { user: { id: "user_admin" }, session: {} },
		input: { projectId: "proj_1", organizationId: "org_example", search },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.projectFindUnique.mockResolvedValue({
		userId: "user_creator",
		organizationId: "org_example",
	});
	mocks.memberFindMany.mockResolvedValue([{ userId: "user_on_project" }]);
	mocks.invitationFindMany.mockResolvedValue([
		{ email: "pending@example.com" },
	]);
	mocks.userFindMany.mockResolvedValue([]);
});

describe("getEligibleUsersProcedure", () => {
	it("requires the permission that manages members, not the one that reads them", () => {
		expect(permissionAtImport).toBe("project:members:manage");
	});

	it("leaves out the project's creator and every member row, accepted or not", async () => {
		await run();

		expect(mocks.memberFindMany.mock.calls[0]?.[0]?.where).toEqual({
			projectId: "proj_1",
		});
		const where = mocks.userFindMany.mock.calls[0]?.[0]?.where;
		expect(where.id.notIn).toEqual(["user_creator", "user_on_project"]);
	});

	it("leaves out anyone with a live invitation to this project", async () => {
		await run();

		const invitations = mocks.invitationFindMany.mock.calls[0]?.[0]?.where;
		expect(invitations).toMatchObject({
			projectId: "proj_1",
			status: "PENDING",
		});
		expect(invitations.expiresAt.gt).toBeInstanceOf(Date);
		const where = mocks.userFindMany.mock.calls[0]?.[0]?.where;
		expect(where.email.notIn).toEqual(["pending@example.com"]);
	});

	it("only offers members of the project's own organization", async () => {
		await run();

		const where = mocks.userFindMany.mock.calls[0]?.[0]?.where;
		expect(where.members).toEqual({
			some: { organizationId: "org_example" },
		});
	});
});
