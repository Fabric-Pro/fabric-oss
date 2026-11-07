import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: mocks.getTenantContext,
}));

const { requireInputOrgPermission } = await import(
	"../../../../orpc/middleware/require-permission"
);

type Context = {
	user: { id: string };
	session: { activeOrganizationId: string | null };
	tenantContext: {
		userId: string;
		type: "organization";
		organizationId: string;
	};
};

function context(): Context {
	return {
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-a" },
		tenantContext: {
			userId: "user-1",
			type: "organization",
			organizationId: "org-a",
		},
	};
}

async function invoke(input: { organizationId: string }) {
	const middleware = requireInputOrgPermission(Permissions.DASHBOARD_READ);
	const next = vi.fn().mockResolvedValue({ output: "ok" });
	await middleware({ context: context(), next } as never, input as never);
	return next;
}

describe("dashboard organization authorization", () => {
	beforeEach(() => {
		mocks.getOrganizationMembership.mockReset();
		mocks.getTenantContext.mockReset();
		mocks.getTenantContext.mockReturnValue({
			effectiveWriteOrgId: undefined,
		});
	});

	it("refuses a caller who names another organization", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(invoke({ organizationId: "org-b" })).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			"org-b",
			"user-1",
		);
	});

	it("refuses a user with no membership in the requested organization", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(invoke({ organizationId: "org-a" })).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
	});

	it("admits a current member with dashboard read permission", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });

		await expect(
			invoke({ organizationId: "org-a" }),
		).resolves.toBeDefined();
	});
});
