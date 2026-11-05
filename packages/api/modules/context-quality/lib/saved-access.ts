import { db } from "@repo/database";
import { Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import { SavedEvaluationError } from "../saved-contracts";
import type { ContextQualityActor } from "./commands";

/** Every transport and background starter uses live, project-authoritative access. */
export async function requireSavedEvaluationAccess(
	actor: ContextQualityActor,
	mode: "read" | "write" | "configure" = "read",
) {
	const [access, project, member] = await Promise.all([
		resolveEffectiveProjectPermissions(actor.projectId, actor.userId),
		db.project.findFirst({
			where: {
				id: actor.projectId,
				organizationId: actor.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		}),
		db.member.findFirst({
			where: {
				organizationId: actor.organizationId,
				userId: actor.userId,
			},
			select: { role: true },
		}),
	]);
	if (
		!project ||
		!access ||
		access.organizationId !== actor.organizationId ||
		access.organizationDeleted ||
		!access.permissions.includes(Permissions.CONTEXT_READ)
	) {
		throw new SavedEvaluationError(
			"FORBIDDEN",
			"Current access to this organization's project context is required.",
		);
	}
	const canWrite = Boolean(
		member && access.permissions.includes(Permissions.PROJECT_UPDATE),
	);
	const canConfigure = Boolean(
		member &&
			["owner", "admin"].includes(member.role.toLowerCase()) &&
			access.permissions.includes(Permissions.PROJECT_SETTINGS_EDIT),
	);
	if (
		(mode === "write" && !canWrite) ||
		(mode === "configure" && !canConfigure)
	) {
		throw new SavedEvaluationError(
			"FORBIDDEN",
			mode === "configure"
				? "An organization administrator with project settings access must approve the evaluation destination."
				: "An organization member with project edit access is required to start or cancel remote evaluations.",
		);
	}
	return { canWrite, canConfigure };
}
