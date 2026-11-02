import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memberFindFirst = vi.fn();
vi.mock("../prisma/client", () => ({
	db: { member: { findFirst: (args: unknown) => memberFindFirst(args) } },
}));

import {
	canCreateOrganizationContext,
	canCreateOrganizationPrompts,
	canExecuteOrganizationAgents,
	canManageOrganizationReportTemplates,
	canReadOrganizationReportTemplates,
	canUpdateOrganizationPrompts,
	canUseOrganizationAiChat,
	canUseOrganizationIntegrations,
} from "../prisma/queries/organization-permissions";

beforeEach(() => memberFindFirst.mockReset());

describe.each([
	[
		"agent execution",
		canExecuteOrganizationAgents,
		Permissions.AGENT_EXECUTE,
	],
	[
		"context creation",
		canCreateOrganizationContext,
		Permissions.CONTEXT_CREATE,
	],
	["AI chat", canUseOrganizationAiChat, Permissions.AI_CHAT],
	[
		"integration use",
		canUseOrganizationIntegrations,
		Permissions.INTEGRATION_USE,
	],
	[
		"prompt creation",
		canCreateOrganizationPrompts,
		Permissions.PROMPT_CREATE,
	],
	["prompt update", canUpdateOrganizationPrompts, Permissions.PROMPT_UPDATE],
	[
		"template management",
		canManageOrganizationReportTemplates,
		Permissions.REPORT_TEMPLATE_MANAGE,
	],
	[
		"template read",
		canReadOrganizationReportTemplates,
		Permissions.REPORT_TEMPLATE_READ,
	],
] as const)("%s permission", (_name, helper, permission: Permission) => {
	it.each(["viewer", "member", "admin", "owner", "unknown"])(
		"checks the current %s role",
		async (role) => {
			memberFindFirst.mockResolvedValue({ role });
			expect(await helper("user-1", "example-org")).toBe(
				hasPermission(resolveOrgPermissions(role), permission),
			);
			expect(memberFindFirst).toHaveBeenCalledWith({
				where: { organizationId: "example-org", userId: "user-1" },
				select: { role: true },
			});
		},
	);

	it("refuses missing membership", async () => {
		memberFindFirst.mockResolvedValue(null);
		expect(await helper("user-1", "example-org")).toBe(false);
	});
});
