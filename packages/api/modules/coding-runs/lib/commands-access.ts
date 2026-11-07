import { ORPCError } from "@orpc/client";
import { canEditProject, hasProjectAccess } from "@repo/database";
import { hasPermission, type Permission } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";

/** A resolved actor; external callers bind organization from the project and credential. */
export interface CodingRunActor {
	userId: string;
	organizationId?: string | null;
}
export async function requireCodingRunProject(
	actor: CodingRunActor,
	projectId: string,
	permission: Permission,
	write = false,
) {
	const access = await resolveEffectiveProjectPermissions(
		projectId,
		actor.userId,
	);
	if (
		!access?.organizationId ||
		(actor.organizationId &&
			actor.organizationId !== access.organizationId) ||
		!(await hasProjectAccess(
			projectId,
			actor.userId,
			access.organizationId,
		))
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Project not found or access denied.",
		});
	}
	if (
		!hasPermission(access.permissions, permission) ||
		(write && !(await canEditProject(projectId, actor.userId)))
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Your current role does not permit this implementation-session operation.",
		});
	}
	return access.organizationId;
}
