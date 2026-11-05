import { createHash } from "node:crypto";
import {
	canReadOrganizationSkills,
	db,
	getAgentTemplateInstanceForRead,
	getProjectAccessContext,
	getSkillById,
	hasProjectAccess,
	isProjectSoftDeleted,
} from "@repo/database";
import { authorizeWorkspaceDocumentRead } from "@repo/database/prisma/queries/workspaces/document-content";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	AGENT_TEST_MAX_BYTES,
	type AgentTestActor,
	AgentTestError,
	type AgentTestScope,
	agentTestScopeSchema,
} from "./agent-test-contracts";

export function boundAgentTest(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value) ?? "") > AGENT_TEST_MAX_BYTES) {
		throw new AgentTestError(
			"BAD_REQUEST",
			"This test is too large. Use a shorter task, fewer checks, or fewer selected sources.",
		);
	}
}
/** Snapshot selectors and identifiers, never credentials or source text. */
export async function loadAgentTestScope(
	actor: AgentTestActor,
	instanceId: string,
) {
	const scoped = await getAgentTemplateInstanceForRead({
		instanceId,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!scoped || scoped.instance.userId !== actor.userId) {
		throw new AgentTestError(
			"NOT_FOUND",
			"Agent not found or access denied. Tests use the agent owner's saved connections.",
		);
	}
	const memoryFiles = await db.agentMemoryFile.findMany({
		where: {
			agentInstanceId: scoped.instance.id,
			userId: actor.userId,
			organizationId: actor.organizationId,
			isEnabled: true,
		},
		select: {
			id: true,
			sourceSkillId: true,
			contentHash: true,
			version: true,
			updatedAt: true,
		},
		orderBy: { id: "asc" },
	});
	const [bindings, integrations, template] = await Promise.all([
		db.agentMCPServerConfiguration.findMany({
			where: { instanceId: scoped.instance.id },
			select: {
				id: true,
				mcpConfigId: true,
				isEnabled: true,
				updatedAt: true,
			},
			orderBy: { id: "asc" },
		}),
		db.agentIntegrationConfiguration.findMany({
			where: { instanceId: scoped.instance.id },
			select: {
				id: true,
				integrationId: true,
				integrationType: true,
				isEnabled: true,
				allowedResources: true,
				updatedAt: true,
			},
			orderBy: { id: "asc" },
		}),
		db.agentTemplate.findUnique({
			where: { id: scoped.instance.templateId },
			select: {
				id: true,
				name: true,
				slug: true,
				displayName: true,
				description: true,
				instructions: true,
				suggestedModel: true,
				modelConfig: true,
				promptBindingId: true,
				version: true,
			},
		}),
	]);
	const instance = scoped.instance;
	const configHash = createHash("sha256")
		.update(
			JSON.stringify({
				instance: {
					templateId: instance.templateId,
					version: instance.version,
					customInstructions: instance.customInstructions,
					toolConnections: instance.toolConnections,
					workspaceIds: instance.workspaceIds,
					modelOverride: instance.modelOverride,
					modelConfig: instance.modelConfig,
					executionMode: instance.executionMode,
					goal: instance.goal,
					maxIterations: instance.maxIterations,
					successCriteria: instance.successCriteria,
				},
				template,
				bindings,
				integrations,
				memoryFiles,
			}),
		)
		.digest("hex");
	const custom = scoped.instance.customInstructions as Record<
		string,
		unknown
	> | null;
	const parsedScope = agentTestScopeSchema.safeParse({
		instanceId: scoped.instance.id,
		configHash,
		projectId: scoped.projectId,
		workspaceIds: scoped.instance.workspaceIds,
		workspaceDocumentFilters: custom?.knowledgeFilters ?? [],
		skillIds: [
			...new Set(
				memoryFiles
					.map((x) => x.sourceSkillId)
					.filter((x): x is string => !!x),
			),
		],
	});
	if (!parsedScope.success) {
		throw new AgentTestError(
			"CONFLICT",
			"The agent's saved knowledge selection is invalid. Review it before running tests.",
		);
	}
	const scope = parsedScope.data;
	await assertAgentTestSourceScope(actor, scope);
	return {
		instance: scoped.instance,
		scope,
		configuration: {
			instance: scoped.instance,
			template,
			bindings,
			integrations,
			memoryFiles,
		},
	};
}
/** Historical checks remain private to their owner and their original source-access boundary. */
export async function assertAgentTestSourceScope(
	actor: AgentTestActor,
	raw: unknown,
): Promise<AgentTestScope> {
	const parsed = agentTestScopeSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AgentTestError(
			"CONFLICT",
			"The agent's saved knowledge selection is invalid. Review it before running tests.",
		);
	}
	const scope = parsed.data;
	if (
		new Set(scope.workspaceIds).size !== scope.workspaceIds.length ||
		new Set(scope.skillIds).size !== scope.skillIds.length ||
		new Set(scope.workspaceDocumentFilters.map((x) => x.workspaceId))
			.size !== scope.workspaceDocumentFilters.length ||
		scope.workspaceDocumentFilters.some(
			(x) => new Set(x.documentIds).size !== x.documentIds.length,
		)
	) {
		throw new AgentTestError(
			"CONFLICT",
			"The saved knowledge selection contains duplicate entries.",
		);
	}
	const scoped = await getAgentTemplateInstanceForRead({
		instanceId: scope.instanceId,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!scoped || scoped.instance.userId !== actor.userId) {
		throw new AgentTestError(
			"NOT_FOUND",
			"Test sources are unavailable or access changed.",
		);
	}
	if (scope.projectId) {
		const context = await getProjectAccessContext(
			scope.projectId,
			actor.userId,
		);
		const permissions = await resolveEffectiveProjectPermissions(
			scope.projectId,
			actor.userId,
		);
		if (
			!permissions ||
			!permissions.permissions.includes("context:read") ||
			context?.organizationId !== actor.organizationId ||
			!(await hasProjectAccess(
				scope.projectId,
				actor.userId,
				actor.organizationId,
			)) ||
			(await isProjectSoftDeleted(scope.projectId))
		) {
			throw new AgentTestError(
				"NOT_FOUND",
				"Test sources are unavailable or access changed.",
			);
		}
	}
	for (const workspaceId of scope.workspaceIds) {
		try {
			await authorizeWorkspaceDocumentRead({ ...actor, workspaceId });
		} catch {
			throw new AgentTestError(
				"NOT_FOUND",
				"Test sources are unavailable or access changed.",
			);
		}
	}
	for (const filter of scope.workspaceDocumentFilters) {
		if (!scope.workspaceIds.includes(filter.workspaceId)) {
			continue; // An inactive saved selection grants no read.
		}
		if (
			filter.documentIds.length &&
			(await db.workspaceDocument.count({
				where: {
					workspaceId: filter.workspaceId,
					id: { in: filter.documentIds },
				},
			})) !== new Set(filter.documentIds).size
		) {
			throw new AgentTestError(
				"NOT_FOUND",
				"Selected test documents are unavailable or access changed.",
			);
		}
	}
	if (
		scope.skillIds.length &&
		!(await canReadOrganizationSkills(actor.userId, actor.organizationId))
	) {
		throw new AgentTestError(
			"FORBIDDEN",
			"Current skill access is required to inspect this test.",
		);
	}
	for (const skillId of scope.skillIds) {
		const skill = await getSkillById(skillId, actor);
		if (
			!skill ||
			(skill.scope !== "SYSTEM" &&
				skill.organizationId !== actor.organizationId)
		) {
			throw new AgentTestError(
				"NOT_FOUND",
				"Selected test skills are unavailable or access changed.",
			);
		}
	}
	return scope;
}
