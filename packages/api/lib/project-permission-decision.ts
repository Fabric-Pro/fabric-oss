import type { Prisma } from "@repo/database";
import { logger } from "@repo/logs";
import { hasPermission, type Permission } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "./effective-project-permissions";

type ProjectPermissionInput = {
	userId: string;
	projectId: string;
	permission: Permission;
};

type ProjectPermissionDecision = {
	allowed: boolean;
	organizationId: string | null;
};

/** Evaluate the project gate's permission rule, allowing lookup errors to propagate. */
export async function resolveProjectPermissionDecision(
	{ userId, projectId, permission }: ProjectPermissionInput,
	client?: Prisma.TransactionClient,
): Promise<ProjectPermissionDecision> {
	const access = await resolveEffectiveProjectPermissions(
		projectId,
		userId,
		client,
	);
	if (!access) {
		return { allowed: false, organizationId: null };
	}
	const allowed =
		access.source !== "none" &&
		access.isVisible !== false &&
		!access.organizationDeleted &&
		(access.source === "owner" ||
			hasPermission(access.permissions, permission));
	return { allowed, organizationId: access.organizationId };
}

/** Resolve permission and the project's organization from the same lookup. */
export async function getProjectPermissionDecision(
	input: ProjectPermissionInput,
	client?: Prisma.TransactionClient,
): Promise<ProjectPermissionDecision> {
	try {
		return await resolveProjectPermissionDecision(input, client);
	} catch {
		// Database errors can include query data. Log the failed operation only.
		logger.error("Project permission lookup failed");
		return { allowed: false, organizationId: null };
	}
}

export async function userHasProjectPermission(
	input: ProjectPermissionInput,
): Promise<boolean> {
	return (await getProjectPermissionDecision(input)).allowed;
}
