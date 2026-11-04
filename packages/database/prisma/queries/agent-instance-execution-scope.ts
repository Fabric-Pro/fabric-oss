import { db } from "../client";
import { getAgentTemplateInstance } from "./agent-templates";
import { readAgentProjectBinding } from "./lib/agent-project-binding";
import {
	canExecuteOrganizationAgents,
	canReadOrganizationAgentTemplates,
} from "./organization-permissions";
import {
	getProjectAccessContext,
	isProjectSoftDeleted,
} from "./projects/projects";

/** A named instance is a scoped execution target, never merely a prompt hint. */
type AgentInstanceScope = {
	instanceId: string;
	userId: string;
	organizationId: string;
};

export function getAgentTemplateInstanceForExecution(
	input: AgentInstanceScope,
) {
	return getScopedAgentInstance(input, canExecuteOrganizationAgents);
}
export function getAgentTemplateInstanceForRead(input: AgentInstanceScope) {
	return getScopedAgentInstance(input, canReadOrganizationAgentTemplates);
}
async function getScopedAgentInstance(
	input: AgentInstanceScope,
	permitted: (userId: string, organizationId: string) => Promise<boolean>,
) {
	if (
		!input.organizationId ||
		!(await permitted(input.userId, input.organizationId))
	) {
		return null;
	}
	const organization = await db.organization.findFirst({
		where: { id: input.organizationId, deletedAt: null },
		select: { id: true },
	});
	if (!organization) {
		return null;
	}
	const instance = await getAgentTemplateInstance(input.instanceId);
	if (!instance || instance.organizationId !== input.organizationId) {
		return null;
	}
	let projectId: string | undefined;
	try {
		projectId = readAgentProjectBinding(
			instance.customInstructions,
			instance.toolConnections,
		);
	} catch {
		return null;
	}
	if (projectId) {
		const access = await getProjectAccessContext(projectId, input.userId);
		if (
			access?.organizationId !== input.organizationId ||
			(await isProjectSoftDeleted(projectId))
		) {
			return null;
		}
	}
	return { instance, projectId };
}
