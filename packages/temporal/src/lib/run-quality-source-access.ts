import {
	canReadOrganizationSkills,
	getProjectAccessContext,
	getSkillById,
	hasProjectAccess,
	isProjectSoftDeleted,
	loadRunQualityTarget,
} from "@repo/database";
import { authorizeWorkspaceDocumentRead } from "@repo/database/prisma/queries/workspaces/document-content";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	type RunQualityActor,
	RunQualityError,
	type RunQualityTarget,
} from "@repo/utils/run-quality-contracts";
import { z } from "zod";
import {
	assertAgentTestSourceScope,
	loadAgentTestScope,
} from "./agent-test-access";
import {
	nativeAgentConfigurationFingerprint,
	nativeConfigurationFromSavedSnapshot,
} from "./native-agent-configuration";

const workflowScope = z.strictObject({
	kind: z.literal("WORKFLOW"),
	projectId: z.string().nullable(),
	workspaceIds: z.array(z.string().max(200)).max(100),
	skillIds: z.array(z.string().max(200)).max(100).default([]),
});
const agentScope = z.strictObject({
	kind: z.literal("AGENT"),
	scope: z.unknown(),
});

/** Capture selectors, never document text, tool arguments or credentials. */
export async function snapshotRunQualitySources(
	actor: RunQualityActor,
	target: RunQualityTarget,
	executed?: { nodes: unknown; projectId: string | null },
) {
	if (target.targetType === "AGENT") {
		const saved = await loadAgentTestScope(actor, target.targetId);
		let configHash: string;
		try {
			configHash = nativeAgentConfigurationFingerprint(
				nativeConfigurationFromSavedSnapshot(saved),
				saved.configuration.instance,
			);
		} catch {
			throw new RunQualityError(
				"BAD_REQUEST",
				"The saved native configuration cannot be verified.",
			);
		}
		return {
			kind: "AGENT" as const,
			scope: { ...saved.scope, configHash },
		};
	}
	const source = await loadRunQualityTarget(actor, target);
	const workspaceIds = new Set<string>();
	const skillIds = new Set<string>();
	const pending: Array<{ value: unknown; depth: number }> = [
		{ value: executed?.nodes ?? source.nodes, depth: 0 },
	];
	let visited = 0;
	while (pending.length) {
		const item = pending.pop();
		if (!item) break;
		if (++visited > 10_000 || item.depth > 16)
			throw new RunQualityError(
				"BAD_REQUEST",
				"Workflow source selectors exceed the quality-check limits.",
			);
		if (Array.isArray(item.value)) {
			for (const value of item.value)
				pending.push({ value, depth: item.depth + 1 });
			continue;
		}
		if (!item.value || typeof item.value !== "object") continue;
		for (const [key, value] of Object.entries(item.value)) {
			if (key === "skillId" && typeof value === "string")
				skillIds.add(value);
			if (key === "skillIds" && Array.isArray(value))
				for (const id of value)
					if (typeof id === "string") skillIds.add(id);
			if (key === "workspaceId" && typeof value === "string")
				workspaceIds.add(value);
			if (key === "workspaceIds" && Array.isArray(value))
				for (const id of value)
					if (typeof id === "string") workspaceIds.add(id);
			if (value && typeof value === "object")
				pending.push({ value, depth: item.depth + 1 });
		}
	}
	const scope = workflowScope.parse({
		kind: "WORKFLOW",
		projectId: executed ? executed.projectId : (source.projectId ?? null),
		workspaceIds: [...workspaceIds],
		skillIds: [...skillIds],
	});
	await assertRunQualitySourceAccess(actor, scope);
	return scope;
}

export async function assertRunQualitySourceAccess(
	actor: RunQualityActor,
	raw: unknown,
) {
	const agent = agentScope.safeParse(raw);
	if (agent.success) {
		await assertAgentTestSourceScope(actor, agent.data.scope);
		return;
	}
	const scope = workflowScope.safeParse(raw);
	if (!scope.success)
		throw new RunQualityError(
			"NOT_FOUND",
			"Result source permissions are unavailable.",
		);
	if (scope.data.projectId) {
		const access = await resolveEffectiveProjectPermissions(
			scope.data.projectId,
			actor.userId,
		);
		if (
			!access?.permissions.includes("context:read") ||
			(await getProjectAccessContext(scope.data.projectId, actor.userId))
				?.organizationId !== actor.organizationId ||
			!(await hasProjectAccess(
				scope.data.projectId,
				actor.userId,
				actor.organizationId,
			)) ||
			(await isProjectSoftDeleted(scope.data.projectId))
		)
			throw new RunQualityError(
				"NOT_FOUND",
				"Result source permissions are unavailable.",
			);
	}
	for (const workspaceId of scope.data.workspaceIds)
		await authorizeWorkspaceDocumentRead({ ...actor, workspaceId });
	if (
		scope.data.skillIds.length &&
		!(await canReadOrganizationSkills(actor.userId, actor.organizationId))
	)
		throw new RunQualityError(
			"NOT_FOUND",
			"Result source permissions are unavailable.",
		);
	for (const skillId of scope.data.skillIds) {
		const skill = await getSkillById(skillId, actor);
		if (
			!skill ||
			(skill.scope !== "SYSTEM" &&
				skill.organizationId !== actor.organizationId)
		)
			throw new RunQualityError(
				"NOT_FOUND",
				"Result source permissions are unavailable.",
			);
	}
}
