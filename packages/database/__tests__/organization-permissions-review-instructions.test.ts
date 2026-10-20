import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { member: { findFirst: mocks.member } },
}));

import {
	canReadOrganizationAgentTemplates,
	canReadOrganizationSkills,
} from "../prisma/queries/organization-permissions";

beforeEach(() => {
	vi.resetAllMocks();
});

describe.each([
	[
		"agent templates",
		canReadOrganizationAgentTemplates,
		Permissions.AGENT_TEMPLATE_READ,
	],
	["skills", canReadOrganizationSkills, Permissions.SKILL_READ],
] as const)("background %s read permission", (_label, helper, permission) => {
	it.each(["owner", "admin", "member", "viewer", "unknown"])(
		"uses the canonical matrix for %s",
		async (role) => {
			mocks.member.mockResolvedValue({ role });
			expect(await helper("user-1", "org-1")).toBe(
				hasPermission(resolveOrgPermissions(role), permission),
			);
			expect(mocks.member).toHaveBeenCalledWith({
				where: { userId: "user-1", organizationId: "org-1" },
				select: { role: true },
			});
		},
	);
	it("refuses a removed membership and rereads after revocation", async () => {
		mocks.member
			.mockResolvedValueOnce({ role: "owner" })
			.mockResolvedValueOnce(null);
		expect(await helper("user-1", "org-1")).toBe(true);
		expect(await helper("user-1", "org-1")).toBe(false);
		expect(mocks.member).toHaveBeenCalledTimes(2);
	});
	it("propagates failed permission reads rather than granting access", async () => {
		mocks.member.mockRejectedValue(new Error("Database unavailable"));
		await expect(helper("user-1", "org-1")).rejects.toThrow(
			"Database unavailable",
		);
	});
});
