import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	membership: vi.fn(),
	check: vi.fn(),
	decrypt: vi.fn(),
}));
vi.mock("@repo/database", () => ({ listWorkflowIntegrations: mocks.list }));
vi.mock("@repo/utils", () => ({ decryptApiKey: mocks.decrypt }));
vi.mock("@repo/integrations/github", () => ({
	testSavedGitHubConnection: mocks.check,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (fn: unknown) => fn,
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { WORKSPACE_READ: "workspace:read" },
		requirePermission: vi.fn(),
		resolveOrganizationId: (id: string) => id,
	};
});

import { testSavedConnectionProcedure } from "../test-saved-connection";

const check = testSavedConnectionProcedure as unknown as (args: {
	input: { type: string; organizationId: string };
	context: { user: { id: string }; session: object };
}) => Promise<unknown>;
const input = { type: "GITHUB", organizationId: "org-example" };
const context = { user: { id: "user-example" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.list.mockResolvedValue([
		{
			id: "workflow-specific",
			workflowId: "workflow-example",
			credentials: "encrypted",
		},
		{ id: "saved-example", workflowId: null, credentials: "encrypted" },
	]);
	mocks.decrypt.mockReturnValue(
		JSON.stringify({
			access_token: "expired-token",
			refresh_token: "refresh-token",
		}),
	);
	mocks.check.mockResolvedValue({
		success: true,
		status: "connected",
		message: "Connected as example-user",
	});
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response("", { status: 401 })),
	);
});

describe("saved GitHub connection identity", () => {
	it("refuses a missing tenant before reading or refreshing a saved connection", async () => {
		expect(
			await check({
				input: {
					...input,
					organizationId: undefined as unknown as string,
				},
				context,
			}),
		).toMatchObject({ success: false, status: "unknown" });
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.check).not.toHaveBeenCalled();
	});
	it("tests the account integration in the authorized tenant using the refresh-aware checker", async () => {
		expect(await check({ input, context })).toEqual({
			success: true,
			status: "connected",
			message: "Connected as example-user",
		});
		expect(mocks.list).toHaveBeenCalledWith({
			userId: "user-example",
			organizationId: "org-example",
			provider: "GITHUB",
		});
		expect(mocks.check).toHaveBeenCalledWith({
			integrationId: "saved-example",
			userId: "user-example",
			organizationId: "org-example",
		});
	});
	it("refuses a nonmember before listing or refreshing credentials", async () => {
		mocks.membership.mockResolvedValue(null);
		await expect(check({ input, context })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.check).not.toHaveBeenCalled();
	});
	it("does not fall back to a workflow-specific credential", async () => {
		mocks.list.mockResolvedValue([
			{
				id: "workflow-specific",
				workflowId: "workflow-example",
				credentials: "encrypted",
			},
		]);
		expect(await check({ input, context })).toMatchObject({
			success: false,
		});
		expect(mocks.check).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
