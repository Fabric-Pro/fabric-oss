import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	findProject: vi.fn(),
	getOrganizationMembership: vi.fn(),
	handler: null as Handler | null,
	handlerCalls: 0,
	middleware: null as Middleware | null,
}));

vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		project: { findFirst: mocks.findProject, findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: () => ({ effectiveWriteOrgId: undefined }),
	grantProjectAccess: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", async () => {
	const permission = await import(
		"../../../../orpc/middleware/require-permission"
	);
	const { Permissions } = await import("@repo/permissions");
	const chain: Record<string, unknown> = {
		use: (middleware: Middleware) => {
			mocks.middleware = middleware;
			return chain;
		},
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (handler: Handler) => {
			mocks.handler = async (args) => {
				mocks.handlerCalls += 1;
				return handler(args);
			};
			return chain;
		},
	};
	return {
		Permissions,
		requireInputOrgPermission: permission.requireInputOrgPermission,
		requirePermission: permission.requirePermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		tenantProtectedProcedure: chain,
	};
});

await import("../project-name-availability");

const USER_ID = "example-user";
const ORG_A = "example-org-a";
const ORG_B = "example-org-b";
const context = {
	user: { id: USER_ID },
	session: { activeOrganizationId: ORG_A },
	activeOrganizationRole: "owner",
	tenantContext: {
		userId: USER_ID,
		type: "organization",
		organizationId: ORG_A,
	},
};

async function invoke(input: Record<string, unknown>) {
	if (!mocks.middleware || !mocks.handler) {
		throw new Error("project-name procedure was not captured");
	}
	const handler = mocks.handler;
	const result = await mocks.middleware(
		{
			context,
			next: async () => ({ output: await handler({ input, context }) }),
		},
		input,
	);
	return (result as { output: unknown }).output;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlerCalls = 0;
	mocks.findProject.mockResolvedValue(null);
	mocks.getOrganizationMembership.mockResolvedValue({
		role: "owner",
		organization: { deletedAt: null },
	});
});

describe("projects.checkName target organization authorization", () => {
	it("refuses a session-org owner with no membership in the named organization before reading projects", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			invoke({ name: "Example project", organizationId: ORG_B }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG_B,
			USER_ID,
		);
		expect(mocks.findProject).not.toHaveBeenCalled();
		expect(mocks.handlerCalls).toBe(0);
	});

	it("refuses a member whose role lacks PROJECT_UPDATE before reading projects", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "viewer",
			organization: { deletedAt: null },
		});

		await expect(
			invoke({ name: "Example project", organizationId: ORG_B }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.findProject).not.toHaveBeenCalled();
	});

	it("refuses an explicit missing organization before reading projects", async () => {
		await expect(
			invoke({ name: "Example project", organizationId: null }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "This operation requires an organization context",
		});
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
		expect(mocks.findProject).not.toHaveBeenCalled();
	});

	it("checks availability for an authorized caller in the named organization", async () => {
		await expect(
			invoke({ name: "Example project", organizationId: ORG_B }),
		).resolves.toEqual({ available: true });
		expect(mocks.findProject).toHaveBeenCalledWith({
			where: expect.objectContaining({ organizationId: ORG_B }),
			select: { id: true },
		});
	});
});
