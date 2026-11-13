import { ORPCError } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_MIDDLEWARE_TAG } from "../../../../orpc/middleware/require-permission";

type Handler = (args: {
	input: Record<string, unknown> | undefined;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;
type Captured = {
	handler: Handler;
	handlerCalls: number;
	middleware: Middleware;
};

const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	procedures: {} as Record<string, Captured>,
}));

vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		project: { findUnique: vi.fn() },
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
	const { Permissions: permissionValues } = await import("@repo/permissions");
	const root = {
		use: (middleware: Middleware) => {
			let route = { method: "", path: "" };
			const chain: Record<string, unknown> = {
				use: () => chain,
				route: (value: { method: string; path: string }) => {
					route = value;
					return chain;
				},
				input: () => chain,
				output: () => chain,
				handler: (handler: Handler) => {
					mocks.procedures[`${route.method} ${route.path}`] = {
						handler,
						handlerCalls: 0,
						middleware,
					};
					return chain;
				},
			};
			return chain;
		},
	};
	return {
		Permissions: permissionValues,
		requireInputOrgPermission: permission.requireInputOrgPermission,
		requirePermission: permission.requirePermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		tenantProtectedProcedure: root,
	};
});

await import("../approval-templates");

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

const criteria = { maxRiskLevel: "high" as const };
const behavior = {
	autoApprove: false,
	notifyOnly: true,
	requireConfirmation: true,
};
const cases = [
	{
		key: "GET /orchestrator/approval-templates",
		permission: Permissions.AGENT_READ,
		input: { organizationId: ORG_B },
	},
	{
		key: "POST /orchestrator/approval-templates",
		permission: Permissions.AGENT_UPDATE,
		input: {
			name: "Example organization template",
			criteria,
			behavior,
			scope: "ORGANIZATION",
			organizationId: ORG_B,
		},
	},
	{
		key: "POST /orchestrator/approval-templates/test",
		permission: Permissions.AGENT_READ,
		input: {
			step: { description: "Example step", riskLevel: "low" },
			organizationId: ORG_B,
		},
	},
] as const;

async function invoke(key: string, input: Record<string, unknown>) {
	const procedure = mocks.procedures[key];
	if (!procedure) {
		throw new Error(`procedure ${key} was not captured`);
	}
	const result = await procedure.middleware(
		{
			context,
			next: async () => {
				procedure.handlerCalls += 1;
				return { output: await procedure.handler({ input, context }) };
			},
		},
		input,
	);
	return (result as { output: unknown }).output;
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const procedure of Object.values(mocks.procedures)) {
		procedure.handlerCalls = 0;
	}
	mocks.getOrganizationMembership.mockResolvedValue({
		role: "owner",
		organization: { deletedAt: null },
	});
});

describe.each(cases)("$key target organization authorization", (testCase) => {
	it("keeps the procedure's existing permission on the target-org gate", () => {
		const middleware = mocks.procedures[testCase.key]?.middleware as
			| (Middleware & Record<symbol, string>)
			| undefined;
		expect(middleware?.[PERMISSION_MIDDLEWARE_TAG]).toBe(
			testCase.permission,
		);
	});

	it("refuses a session-org owner with no membership in the named organization before the handler can read or write", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			invoke(testCase.key, testCase.input),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG_B,
			USER_ID,
		);
		expect(mocks.procedures[testCase.key]?.handlerCalls).toBe(0);
	});

	it("refuses a missing organization before the handler can read or write", async () => {
		await expect(
			invoke(testCase.key, { ...testCase.input, organizationId: null }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "This operation requires an organization context",
		});
		expect(mocks.procedures[testCase.key]?.handlerCalls).toBe(0);
	});

	it("allows a target-org owner to run the procedure", async () => {
		await expect(
			invoke(testCase.key, testCase.input),
		).resolves.not.toBeInstanceOf(ORPCError);
		expect(mocks.procedures[testCase.key]?.handlerCalls).toBe(1);
	});
});
