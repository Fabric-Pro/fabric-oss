import { createHash } from "node:crypto";
import {
	canExecuteOrganizationAgents,
	canReadOrganizationSkills,
	db,
	getAgentTemplateInstanceForRead,
	getSkillById,
	hasPermission,
	hasProjectAccess,
	isProjectSoftDeleted,
	Permissions,
} from "@repo/database";
import {
	authorizeWorkspaceDocumentRead,
	WorkspaceDocumentContentError,
} from "@repo/database/prisma/queries/workspaces/document-content";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	AGENT_PREVIEW_MAX_BYTES,
	type AgentPreviewActor,
	type AgentPreviewDraft,
	agentPreviewDraftSchema,
	agentPreviewStartSchema,
	agentPreviewUnsupported,
} from "./agent-preview-contracts";

export class AgentPreviewAccessError extends Error {
	constructor(
		readonly code: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST",
		message: string,
	) {
		super(message);
		this.name = "AgentPreviewAccessError";
	}
}
export function previewRequestHash(raw: unknown): string {
	const value = agentPreviewStartSchema.parse(raw);
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > AGENT_PREVIEW_MAX_BYTES) {
		throw new AgentPreviewAccessError(
			"BAD_REQUEST",
			"Preview context exceeds the 128 KiB request limit.",
		);
	}
	return createHash("sha256").update(encoded).digest("hex");
}
export function previewWorkflowId(
	actor: AgentPreviewActor,
	key: string,
): string {
	const scope = createHash("sha256")
		.update(JSON.stringify([actor.organizationId, actor.userId]))
		.digest("hex")
		.slice(0, 24);
	return `agent-preview-${scope}-${key}`;
}
/** Repeat at every activity boundary and before releasing retained results. */
export async function assertAgentPreviewAccess(
	actor: AgentPreviewActor,
	raw: AgentPreviewDraft,
): Promise<void> {
	const draft = agentPreviewDraftSchema.parse(raw);
	if (!actor.organizationId || !actor.userId) {
		throw new AgentPreviewAccessError(
			"FORBIDDEN",
			"An organization and current member are required.",
		);
	}
	const member = await db.member.findFirst({
		where: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			organization: { deletedAt: null },
		},
		select: { role: true },
	});
	if (
		!member ||
		!(await canExecuteOrganizationAgents(
			actor.userId,
			actor.organizationId,
		))
	) {
		throw new AgentPreviewAccessError(
			"FORBIDDEN",
			"Your current role does not allow agent previews.",
		);
	}
	const unsupported = agentPreviewUnsupported(draft);
	if (unsupported.length) {
		throw new AgentPreviewAccessError("BAD_REQUEST", unsupported.join(" "));
	}
	if (draft.instanceId) {
		const scoped = await getAgentTemplateInstanceForRead({
			instanceId: draft.instanceId,
			...actor,
		});
		if (!scoped) {
			throw new AgentPreviewAccessError(
				"NOT_FOUND",
				"Agent not found or access denied.",
			);
		}
	}
	if (draft.projectId) {
		const access = await resolveEffectiveProjectPermissions(
			draft.projectId,
			actor.userId,
		);
		if (
			!access ||
			access.organizationId !== actor.organizationId ||
			access.organizationDeleted ||
			!hasPermission(access.permissions, Permissions.CONTEXT_READ) ||
			!(await hasProjectAccess(
				draft.projectId,
				actor.userId,
				actor.organizationId,
			)) ||
			(await isProjectSoftDeleted(draft.projectId))
		) {
			throw new AgentPreviewAccessError(
				"NOT_FOUND",
				"Project context not found or access denied.",
			);
		}
	}
	if (
		new Set(draft.workspaceIds).size !== draft.workspaceIds.length ||
		new Set(draft.skillIds).size !== draft.skillIds.length ||
		new Set(draft.workspaceDocumentFilters.map((x) => x.workspaceId))
			.size !== draft.workspaceDocumentFilters.length
	) {
		throw new AgentPreviewAccessError(
			"BAD_REQUEST",
			"Preview selections must be unique.",
		);
	}
	for (const filter of draft.workspaceDocumentFilters) {
		if (
			!draft.workspaceIds.includes(filter.workspaceId) ||
			new Set(filter.documentIds).size !== filter.documentIds.length
		) {
			throw new AgentPreviewAccessError(
				"BAD_REQUEST",
				"Document filters must belong to a selected workspace and contain unique documents.",
			);
		}
	}
	for (const workspaceId of draft.workspaceIds) {
		try {
			await authorizeWorkspaceDocumentRead({ ...actor, workspaceId });
		} catch (error) {
			if (error instanceof WorkspaceDocumentContentError) {
				throw new AgentPreviewAccessError(
					error.code === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND",
					"Workspace not found or access denied.",
				);
			}
			throw error;
		}
		const selected =
			draft.workspaceDocumentFilters.find(
				(x) => x.workspaceId === workspaceId,
			)?.documentIds ?? [];
		if (selected.length) {
			const count = await db.workspaceDocument.count({
				where: { id: { in: selected }, workspaceId },
			});
			if (count !== selected.length) {
				throw new AgentPreviewAccessError(
					"NOT_FOUND",
					"Selected documents are unavailable in this workspace.",
				);
			}
		}
	}
	if (
		draft.skillIds.length &&
		!(await canReadOrganizationSkills(actor.userId, actor.organizationId))
	) {
		throw new AgentPreviewAccessError(
			"FORBIDDEN",
			"Your current role does not allow reading skills.",
		);
	}
	for (const skillId of draft.skillIds) {
		const skill = await getSkillById(skillId, actor);
		if (
			!skill ||
			(skill.scope !== "SYSTEM" &&
				skill.organizationId !== actor.organizationId)
		) {
			throw new AgentPreviewAccessError(
				"NOT_FOUND",
				"Selected skill not found or access denied.",
			);
		}
		if (await db.skillFile.count({ where: { skillId } })) {
			throw new AgentPreviewAccessError(
				"BAD_REQUEST",
				"Skills with attached files need a saved-agent run. Choose skills with instructions only for this preview.",
			);
		}
	}
}
