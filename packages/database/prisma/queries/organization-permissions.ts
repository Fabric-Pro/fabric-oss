/**
 * Organization-level permission checks for non-oRPC surfaces.
 *
 * The project-scoped siblings of these helpers live in `projects/projects.ts`
 * (`canEditProject`, `canCreateProjectStory`, `canUpdateProjectStory`) and
 * answer "what may this person do to *this project*". These answer the question
 * that has no project to hang off: creating one, or acting on a resource that
 * belongs to the organization rather than to any project — a frame, say.
 *
 * They exist for the same reason the project ones do. oRPC procedures reach the
 * permission matrix through `requirePermission`, and every surface that cannot
 * mount middleware — the MCP gateway, Next.js route handlers, agent tools — has
 * to arrive at the same verdict some other way. When it does not, the two drift,
 * and the drift is only ever discovered from the permissive side.
 */

import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { db } from "../client";

/**
 * Does `userId` hold `permission` in `organizationId`, by their org role?
 *
 * Deliberately not exported: callers should ask a named question below rather
 * than pass a permission constant across a package boundary. `apps/web` does
 * not depend on `@repo/permissions`, and it should not have to in order to find
 * out whether someone may create a frame.
 */
async function organizationPermissionHolds(
	userId: string,
	organizationId: string,
	permission: Permission,
): Promise<boolean> {
	const orgMember = await db.member.findFirst({
		where: { organizationId, userId },
		select: { role: true },
	});

	if (!orgMember) {
		return false;
	}

	return hasPermission(resolveOrgPermissions(orgMember.role), permission);
}

/**
 * Returns `true` if `userId` may create a project in `organizationId`, matching
 * `requirePermission(PROJECT_CREATE)`.
 *
 * At creation time there is no project to hold a `ProjectMember` row, so this is
 * the one project question that has to be asked of the organization.
 */
export async function canCreateProjectInOrganization(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.PROJECT_CREATE,
	);
}

/**
 * Returns `true` if `userId` may create frames (and slideshows, which are
 * frames) in `organizationId`, matching `requirePermission(WORKSPACE_CREATE)`.
 */
export async function canCreateOrganizationFrames(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.WORKSPACE_CREATE,
	);
}

/**
 * Returns `true` if `userId` may modify or share frames in `organizationId`,
 * matching `requirePermission(WORKSPACE_UPDATE)`.
 */
export async function canUpdateOrganizationFrames(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.WORKSPACE_UPDATE,
	);
}
