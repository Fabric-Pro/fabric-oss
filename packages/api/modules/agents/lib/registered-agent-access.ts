import { verifyOrganizationMembership } from "../../organizations/lib/membership";

type RegisteredAgentAccessResult =
	| { allowed: true }
	| {
			allowed: false;
			reason:
				| "Invalid organization agent configuration"
				| "You do not have access to this agent"
				| "Agent does not belong to the specified organization"
				| "Personal agent not accessible in organization context"
				| "Invalid agent scope";
	  };

/** Check registry visibility against the loaded row and resolved caller context. */
export async function checkRegisteredAgentAccess(
	agent: {
		scope: string;
		userId: string | null;
		organizationId: string | null;
	},
	userId: string,
	organizationId: string | null | undefined,
): Promise<RegisteredAgentAccessResult> {
	switch (agent.scope) {
		case "SYSTEM":
			return { allowed: true };
		case "ORGANIZATION": {
			if (!agent.organizationId) {
				return {
					allowed: false,
					reason: "Invalid organization agent configuration",
				};
			}
			const membership = await verifyOrganizationMembership(
				agent.organizationId,
				userId,
			);
			if (!membership) {
				return {
					allowed: false,
					reason: "You do not have access to this agent",
				};
			}
			if (organizationId && organizationId !== agent.organizationId) {
				return {
					allowed: false,
					reason: "Agent does not belong to the specified organization",
				};
			}
			return { allowed: true };
		}
		case "USER":
			if (agent.userId !== userId) {
				return {
					allowed: false,
					reason: "You do not have access to this agent",
				};
			}
			if (organizationId && !agent.organizationId) {
				return {
					allowed: false,
					reason: "Personal agent not accessible in organization context",
				};
			}
			return { allowed: true };
		default:
			return { allowed: false, reason: "Invalid agent scope" };
	}
}

type RegisteredAgentManageAccessResult =
	| RegisteredAgentAccessResult
	| {
			allowed: false;
			reason:
				| "System agents cannot be modified"
				| "Organization agents can only be modified by administrators";
	  };

/**
 * Check whether the caller may change a registered agent row: SYSTEM rows are
 * refused, ORGANIZATION rows need an owner or admin of the agent's
 * organization, and USER rows follow the read rule (owner only).
 */
export async function checkRegisteredAgentManageAccess(
	agent: {
		scope: string;
		userId: string | null;
		organizationId: string | null;
	},
	userId: string,
	organizationId: string | null | undefined,
): Promise<RegisteredAgentManageAccessResult> {
	if (agent.scope === "SYSTEM") {
		return { allowed: false, reason: "System agents cannot be modified" };
	}
	if (agent.scope !== "ORGANIZATION") {
		return checkRegisteredAgentAccess(agent, userId, organizationId);
	}
	if (!agent.organizationId) {
		return {
			allowed: false,
			reason: "Invalid organization agent configuration",
		};
	}
	const membership = await verifyOrganizationMembership(
		agent.organizationId,
		userId,
	);
	if (!membership) {
		return {
			allowed: false,
			reason: "You do not have access to this agent",
		};
	}
	if (organizationId && organizationId !== agent.organizationId) {
		return {
			allowed: false,
			reason: "Agent does not belong to the specified organization",
		};
	}
	if (membership.role !== "owner" && membership.role !== "admin") {
		return {
			allowed: false,
			reason: "Organization agents can only be modified by administrators",
		};
	}
	return { allowed: true };
}
