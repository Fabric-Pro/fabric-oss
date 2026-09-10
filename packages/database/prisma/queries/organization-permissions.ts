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

/**
 * Returns `true` if `userId` may read `organizationId`'s audit log, matching
 * `requirePermission(ORG_AUDIT_LOG_READ)`.
 *
 * Asked by the public audit-log REST surface, which authenticates with an API
 * key rather than a session and so cannot mount the oRPC middleware. The key
 * records the scopes chosen when it was minted; this records what its owner may
 * do *today*. Both have to hold — see the note on the export sibling.
 */
export async function canReadOrganizationAuditLog(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.ORG_AUDIT_LOG_READ,
	);
}

/**
 * Returns `true` if `userId` may export `organizationId`'s audit log, matching
 * `requirePermission(ORG_AUDIT_LOG_EXPORT)`.
 *
 * Read and export are separate permissions in the matrix and separate scopes on
 * the key, so they are separate questions here. Collapsing them would let an
 * export-scoped key answer a read question, which is the drift these helpers
 * exist to prevent.
 */
export async function canExportOrganizationAuditLog(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.ORG_AUDIT_LOG_EXPORT,
	);
}

/**
 * Returns `true` if `userId` may run agents in `organizationId`, matching
 * `requirePermission(AGENT_EXECUTE)`.
 *
 * The read siblings deliberately have no helper. `AGENT_READ` and
 * `AGENT_TEMPLATE_READ` sit in the viewer set — every role holds them — so a
 * gate on `agents:read` could refuse nobody and would only suggest, falsely,
 * that reading agents is narrower than it is. Executing them is member-and-up,
 * which is the line worth checking.
 */
export async function canExecuteOrganizationAgents(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return organizationPermissionHolds(
		userId,
		organizationId,
		Permissions.AGENT_EXECUTE,
	);
}
