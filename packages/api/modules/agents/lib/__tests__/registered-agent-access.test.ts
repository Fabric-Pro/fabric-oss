import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkRegisteredAgentAccess,
	checkRegisteredAgentManageAccess,
} from "../registered-agent-access";

const { verifyOrganizationMembership } = vi.hoisted(() => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

beforeEach(() => {
	verifyOrganizationMembership.mockReset();
	verifyOrganizationMembership.mockResolvedValue({ role: "member" });
});

const ownAgent = {
	scope: "USER",
	userId: "example-user",
	organizationId: "example-org",
};

describe("checkRegisteredAgentAccess", () => {
	it.each([
		[
			"SYSTEM",
			{ scope: "SYSTEM", userId: null, organizationId: null },
			"example-org",
		],
		[
			"own organization",
			{ ...ownAgent, scope: "ORGANIZATION" },
			"example-org",
		],
		[
			"organization with no caller organization",
			{ ...ownAgent, scope: "ORGANIZATION" },
			null,
		],
		["own user in organization", ownAgent, "example-org"],
		[
			"own personal user without organization context",
			{ ...ownAgent, organizationId: null },
			null,
		],
		[
			"own user with a different nonempty organization (registry compatibility)",
			ownAgent,
			"other-org",
		],
	])("allows %s", async (_name, agent, organizationId) => {
		await expect(
			checkRegisteredAgentAccess(agent, "example-user", organizationId),
		).resolves.toEqual({ allowed: true });
		if (agent.scope === "ORGANIZATION") {
			expect(
				verifyOrganizationMembership,
			).toHaveBeenCalledExactlyOnceWith("example-org", "example-user");
		} else {
			expect(verifyOrganizationMembership).not.toHaveBeenCalled();
		}
	});
	it.each([
		[
			"missing organization",
			{ ...ownAgent, scope: "ORGANIZATION", organizationId: null },
			true,
			"Invalid organization agent configuration",
		],
		[
			"nonmember",
			{ ...ownAgent, scope: "ORGANIZATION" },
			false,
			"You do not have access to this agent",
		],
		[
			"different organization",
			{ ...ownAgent, scope: "ORGANIZATION", organizationId: "other-org" },
			true,
			"Agent does not belong to the specified organization",
		],
		[
			"membership denial before org mismatch",
			{ ...ownAgent, scope: "ORGANIZATION", organizationId: "other-org" },
			false,
			"You do not have access to this agent",
		],
		[
			"different owner",
			{ ...ownAgent, userId: "other-user" },
			true,
			"You do not have access to this agent",
		],
		[
			"ownership denial before personal context",
			{ ...ownAgent, userId: null, organizationId: null },
			true,
			"You do not have access to this agent",
		],
		[
			"personal user in organization",
			{ ...ownAgent, organizationId: null },
			true,
			"Personal agent not accessible in organization context",
		],
		[
			"unknown scope",
			{ ...ownAgent, scope: "UNKNOWN" },
			true,
			"Invalid agent scope",
		],
	])(
		"denies %s with the registry reason",
		async (_name, agent, member, reason) => {
			verifyOrganizationMembership.mockResolvedValue(
				member ? { role: "member" } : null,
			);
			await expect(
				checkRegisteredAgentAccess(
					agent,
					"example-user",
					"example-org",
				),
			).resolves.toEqual({ allowed: false, reason });
			expect(verifyOrganizationMembership).toHaveBeenCalledTimes(
				agent.scope === "ORGANIZATION" && agent.organizationId ? 1 : 0,
			);
		},
	);
	it("propagates membership lookup errors", async () => {
		const error = new Error("Membership lookup unavailable");
		verifyOrganizationMembership.mockRejectedValue(error);
		await expect(
			checkRegisteredAgentAccess(
				{ ...ownAgent, scope: "ORGANIZATION" },
				"example-user",
				"example-org",
			),
		).rejects.toBe(error);
	});
});

describe("checkRegisteredAgentManageAccess", () => {
	it.each([
		["owner", { ...ownAgent, scope: "ORGANIZATION" }, "owner"],
		["admin", { ...ownAgent, scope: "ORGANIZATION" }, "admin"],
		["own user agent", ownAgent, "member"],
	])("allows %s", async (_name, agent, role) => {
		verifyOrganizationMembership.mockResolvedValue({ role });
		await expect(
			checkRegisteredAgentManageAccess(
				agent,
				"example-user",
				"example-org",
			),
		).resolves.toEqual({ allowed: true });
	});
	it.each([
		[
			"SYSTEM",
			{ scope: "SYSTEM", userId: null, organizationId: null },
			"member",
			"System agents cannot be modified",
		],
		[
			"organization member without admin role",
			{ ...ownAgent, scope: "ORGANIZATION" },
			"member",
			"Organization agents can only be modified by administrators",
		],
		[
			"admin of a different organization context",
			{ ...ownAgent, scope: "ORGANIZATION", organizationId: "other-org" },
			"admin",
			"Agent does not belong to the specified organization",
		],
		[
			"nonmember",
			{ ...ownAgent, scope: "ORGANIZATION" },
			null,
			"You do not have access to this agent",
		],
		[
			"another member's user agent in the same organization",
			{ ...ownAgent, userId: "other-user" },
			"owner",
			"You do not have access to this agent",
		],
	])("denies %s", async (_name, agent, role, reason) => {
		verifyOrganizationMembership.mockResolvedValue(role ? { role } : null);
		await expect(
			checkRegisteredAgentManageAccess(
				agent,
				"example-user",
				"example-org",
			),
		).resolves.toEqual({ allowed: false, reason });
	});
});
