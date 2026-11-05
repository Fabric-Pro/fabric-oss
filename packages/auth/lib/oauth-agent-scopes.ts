import {
	canExecuteOrganizationAgents,
	canReadOrganizationAgents,
	canScheduleOrganizationAgents,
} from "@repo/database";
import { APIError } from "better-auth/api";

/** Called from the provider's consent-reference hook, including silent reuse of an existing consent. */
export async function authorizeOAuthAgentScopes(
	userId: string,
	organizationId: string,
	scopes: readonly string[],
	projectBound: boolean,
): Promise<void> {
	const agentScopes = scopes.filter(
		(scope) =>
			scope === "agents:read" ||
			scope === "agents:execute" ||
			scope === "agents:schedule",
	);
	if (!agentScopes.length) {
		return;
	}
	const refuse = () => {
		throw new APIError("FORBIDDEN", {
			error: "access_denied",
			error_description:
				"Agent run controls require an organization grant and your current agent permissions. Recurring work additionally requires both agents:execute and agents:schedule.",
		});
	};
	if (projectBound || !organizationId) {
		refuse();
	}
	if (
		scopes.includes("agents:schedule") &&
		!scopes.includes("agents:execute")
	) {
		refuse();
	}
	if (
		scopes.includes("agents:read") &&
		!(await canReadOrganizationAgents(userId, organizationId))
	) {
		refuse();
	}
	if (
		scopes.includes("agents:execute") &&
		!(await canExecuteOrganizationAgents(userId, organizationId))
	) {
		refuse();
	}
	if (
		scopes.includes("agents:schedule") &&
		!(await canScheduleOrganizationAgents(userId, organizationId))
	) {
		refuse();
	}
}
