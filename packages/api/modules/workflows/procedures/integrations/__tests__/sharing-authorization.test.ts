import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	member: vi.fn(),
	connections: vi.fn(),
	setScope: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: mocks.member },
		workflowIntegration: { findMany: mocks.connections },
	},
	getOrganizationMembership: mocks.membership,
	getTenantContext: () => ({ effectiveWriteOrgId: undefined }),
	grantProjectAccess: vi.fn(),
	// Mirrors the real predicate (queries/workflows/integration-access.ts).
	isShareableIntegrationProvider: (provider: string) => provider !== "GITLAB",
	workflowIntegrationAccessWhere: (
		userId: string,
		organizationId: string,
	) => ({
		userId,
		organizationId,
	}),
}));

vi.mock("../../../lib/integration-sharing", () => ({
	setIntegrationUsageScope: mocks.setScope,
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } = await import("@repo/permissions");
	const { requireInputOrgPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
	let middleware: unknown;
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		input: () => chain,
		use: (value: unknown) => {
			middleware = value;
			return chain;
		},
		handler: (handler: unknown) => {
			const procedure = { handler, middleware };
			middleware = undefined;
			return procedure;
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions,
		requireInputOrgPermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId: string },
		) => (input === undefined ? session.activeOrganizationId : input),
	};
});

import {
	listIntegrationSharingProcedure,
	setIntegrationUsageScopeProcedure,
} from "../sharing";

const context = {
	user: { id: "actor", email: "dev@example.com" },
	session: { activeOrganizationId: "session-org" },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
};
const input = {
	organizationId: "target-org",
	integrationId: "connection-example",
	usageScope: "OWNER_ONLY",
};

async function invoke(procedure: unknown, organizationId: string | null) {
	const wired = procedure as {
		handler: (args: unknown) => Promise<unknown>;
		middleware?: (
			args: { context: typeof context; next: () => Promise<unknown> },
			input: unknown,
		) => Promise<unknown>;
	};
	const args = { context, input: { ...input, organizationId } };
	const next = () => wired.handler(args);
	return wired.middleware
		? wired.middleware({ context, next }, args.input)
		: next();
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "viewer" });
	mocks.member.mockResolvedValue({ role: "viewer" });
	mocks.connections.mockResolvedValue([]);
	mocks.setScope.mockResolvedValue({ success: true });
});

describe.each([
	["listing", listIntegrationSharingProcedure],
	["setting scope", setIntegrationUsageScopeProcedure],
])("sharing %s target organization authorization", (_name, procedure) => {
	it("rejects a nonmember of the target organization before handler effects", async () => {
		mocks.membership.mockResolvedValue(null);
		await expect(invoke(procedure, "target-org")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.membership).toHaveBeenCalledWith("target-org", "actor");
		expect(mocks.member).not.toHaveBeenCalled();
		expect(mocks.connections).not.toHaveBeenCalled();
		expect(mocks.setScope).not.toHaveBeenCalled();
	});

	it("requires organization context before handler effects", async () => {
		await expect(invoke(procedure, null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.membership).not.toHaveBeenCalled();
		expect(mocks.member).not.toHaveBeenCalled();
		expect(mocks.setScope).not.toHaveBeenCalled();
	});

	it("lets a current viewer reach the connection ownership policy", async () => {
		await invoke(procedure, "target-org");
		expect(mocks.membership).toHaveBeenCalledWith("target-org", "actor");
		if (procedure === setIntegrationUsageScopeProcedure) {
			expect(mocks.setScope).toHaveBeenCalledWith(input, context.user);
		} else {
			expect(mocks.connections).toHaveBeenCalled();
		}
	});
});

describe("sharing listing for a personal GitLab connection", () => {
	it("never offers to share it, and says it is personal", async () => {
		mocks.membership.mockResolvedValue({ role: "owner" });
		mocks.member.mockResolvedValue({ role: "owner" });
		mocks.connections.mockResolvedValue([
			{
				id: "gitlab-1",
				userId: "actor",
				provider: "GITLAB",
				name: "GitLab",
				usageScope: "OWNER_ONLY",
				isActive: true,
			},
			{
				id: "gmail-1",
				userId: "actor",
				provider: "GMAIL",
				name: "Gmail",
				usageScope: "OWNER_ONLY",
				isActive: true,
			},
		]);

		const result = (await invoke(
			listIntegrationSharingProcedure,
			"target-org",
		)) as {
			connections: Array<{
				id: string;
				canShare: boolean;
				personalOnly: boolean;
			}>;
		};

		expect(result.connections).toEqual([
			expect.objectContaining({
				id: "gitlab-1",
				canShare: false,
				personalOnly: true,
			}),
			expect.objectContaining({
				id: "gmail-1",
				canShare: true,
				personalOnly: false,
			}),
		]);
	});
});
