/**
 * The organization gate the MCP config routes call before they load a config
 * or build an MCP client (Fizzy #2897).
 *
 * The three database questions are mocked here; which roles hold MCP_READ and
 * MCP_CONNECT is the database helpers' contract, pinned against the live
 * permission matrix in
 * `packages/database/__tests__/organization-permissions-mcp.test.ts`. This
 * suite pins the gate's own logic: which question each action asks, that the
 * allowed path costs one read, and that the two refusals stay distinguishable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canReadOrganizationMcpConfigs: vi.fn(),
	canConnectOrganizationMcpConfigs: vi.fn(),
	isOrganizationMember: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canReadOrganizationMcpConfigs: mocks.canReadOrganizationMcpConfigs,
	canConnectOrganizationMcpConfigs: mocks.canConnectOrganizationMcpConfigs,
	isOrganizationMember: mocks.isOrganizationMember,
}));

import {
	authorizeMcpConfigRequest,
	MCP_ORGANIZATION_MEMBERSHIP_REQUIRED,
	MCP_PERMISSION_DENIED,
} from "../authorize-mcp-config-request";

async function refusalBody(
	result: Awaited<ReturnType<typeof authorizeMcpConfigRequest>>,
) {
	if (result.ok) {
		throw new Error("expected a refusal");
	}
	expect(result.response.status).toBe(403);
	return (await result.response.json()) as Record<string, unknown>;
}

function expectNoReads() {
	expect(mocks.canReadOrganizationMcpConfigs).not.toHaveBeenCalled();
	expect(mocks.canConnectOrganizationMcpConfigs).not.toHaveBeenCalled();
	expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
}

describe("authorizeMcpConfigRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["an empty string", ""],
	])(
		"allows the personal arm (organization %s) without a read",
		async (_label, organizationId) => {
			const result = await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId,
				action: "connect",
			});

			expect(result).toEqual({ ok: true });
			expectNoReads();
		},
	);

	it.each([
		["read", "canReadOrganizationMcpConfigs"],
		["connect", "canConnectOrganizationMcpConfigs"],
	] as const)(
		"allows %s on one read of its own permission question",
		async (action, helper) => {
			mocks[helper].mockResolvedValue(true);

			const result = await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action,
			});

			expect(result).toEqual({ ok: true });
			expect(mocks[helper]).toHaveBeenCalledWith("user-1", "org-1");
			expect(mocks[helper]).toHaveBeenCalledTimes(1);
			// The allowed path never reaches the membership read.
			expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		},
	);

	it("asks the connect question, not the read one, for tool execution", async () => {
		// A viewer: holds read, not connect.
		mocks.canReadOrganizationMcpConfigs.mockResolvedValue(true);
		mocks.canConnectOrganizationMcpConfigs.mockResolvedValue(false);
		mocks.isOrganizationMember.mockResolvedValue(true);

		const body = await refusalBody(
			await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action: "connect",
			}),
		);

		expect(body.code).toBe(MCP_PERMISSION_DENIED);
		expect(body.action).toBe("connect");
		expect(mocks.canReadOrganizationMcpConfigs).not.toHaveBeenCalled();
		expect(JSON.stringify(body)).not.toContain("org-1");
	});

	it("refuses a former member with the membership code", async () => {
		mocks.canReadOrganizationMcpConfigs.mockResolvedValue(false);
		mocks.isOrganizationMember.mockResolvedValue(false);

		const body = await refusalBody(
			await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action: "read",
			}),
		);

		expect(body.code).toBe(MCP_ORGANIZATION_MEMBERSHIP_REQUIRED);
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		// No ids in the refusal.
		expect(JSON.stringify(body)).not.toContain("org-1");
		expect(JSON.stringify(body)).not.toContain("user-1");
	});

	it("refuses a member whose role does not allow the action with the permission code", async () => {
		// Also the shape of an unknown stored role: a membership row whose role
		// resolves to no permissions.
		mocks.canReadOrganizationMcpConfigs.mockResolvedValue(false);
		mocks.isOrganizationMember.mockResolvedValue(true);

		const body = await refusalBody(
			await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action: "read",
			}),
		);

		expect(body.code).toBe(MCP_PERMISSION_DENIED);
		expect(body.action).toBe("read");
	});

	it("refuses an organization id that is not a string, without a read", async () => {
		const body = await refusalBody(
			await authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: { not: "a string" } as unknown as string,
				action: "read",
			}),
		);

		expect(body.code).toBe(MCP_ORGANIZATION_MEMBERSHIP_REQUIRED);
		expectNoReads();
	});

	it("propagates a failed permission read instead of allowing", async () => {
		mocks.canConnectOrganizationMcpConfigs.mockRejectedValue(
			new Error("db down"),
		);

		await expect(
			authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action: "connect",
			}),
		).rejects.toThrow("db down");
	});

	it("propagates a failed membership read instead of allowing", async () => {
		mocks.canReadOrganizationMcpConfigs.mockResolvedValue(false);
		mocks.isOrganizationMember.mockRejectedValue(new Error("db down"));

		await expect(
			authorizeMcpConfigRequest({
				userId: "user-1",
				organizationId: "org-1",
				action: "read",
			}),
		).rejects.toThrow("db down");
	});
});
