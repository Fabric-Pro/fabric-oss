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
 * The SET form of `organizationPermissionHolds`: which of `userIds` hold
 * `permission` in `organizationId`?
 *
 * Not exported for the same reason its single-user sibling is not — a caller
 * asks a named question below. It exists because the one-at-a-time helper is
 * the wrong tool for a list: a fan-out resolving an audience would issue one
 * round trip per candidate, and the answer is one indexed `IN (...)` read.
 *
 * Argument order is deliberately the mirror of the sibling's. The organization
 * is the constant and the people are what varies, so it reads the way the query
 * does. Members with no row, and members whose stored role the matrix does not
 * recognise, are simply absent from the result: an unknown role resolves to the
 * empty permission set, which fails closed (Fizzy #2457).
 */
async function organizationPermissionHoldsForAll(
	organizationId: string,
	userIds: string[],
	permission: Permission,
): Promise<Set<string>> {
	const uniqueIds = Array.from(new Set(userIds)).filter(Boolean);
	if (!organizationId || uniqueIds.length === 0) {
		return new Set();
	}

	const orgMembers = await db.member.findMany({
		where: { organizationId, userId: { in: uniqueIds } },
		select: { userId: true, role: true },
	});

	const holders = new Set<string>();
	for (const orgMember of orgMembers) {
		if (hasPermission(resolveOrgPermissions(orgMember.role), permission)) {
			holders.add(orgMember.userId);
		}
	}
	return holders;
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

/**
 * Returns `true` if `userId` may start a workflow run in `organizationId`,
 * matching `requirePermission(WORKSPACE_UPDATE)` on the in-app start.
 *
 * Asked of an API key's owner by the v1 `workflows:run` gate and of the MCP
 * session's user by `fabric_execute_workflow`: both carry stored scopes, and a
 * stored scope says what the key was granted, not what its owner may do now.
 */
export async function canRunOrganizationWorkflows(
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
 * Which of `userIds` may create an API key in `organizationId`, matching
 * `requirePermission(ORG_API_KEYS_CREATE)` asked of each of them.
 *
 * The one question on this surface that is naturally asked about a LIST rather
 * than about a person: the CLI-connection ask resolves an audience and has to
 * drop everybody who could not act on it, because the ask is "mint a key" and
 * handing that to somebody who cannot is handing them a dead end (Fizzy #2457).
 *
 * Returns the ids that hold the permission, so the caller filters rather than
 * branching. Anyone absent from the result is ineligible for one of two
 * reasons the caller does not need to tell apart: no membership row in this
 * organization at all — the project guest reaching a project through a
 * `ProjectMember` row — or a stored role the matrix does not recognise. Both
 * resolve to the empty permission set.
 *
 * Which ranks carry `ORG_API_KEYS_CREATE` has already moved twice, so nothing
 * here names a rank. It asks the matrix, exactly as the create procedure's own
 * gate does, so the door a key is minted through and the door a recipient is
 * judged at cannot answer the same question differently.
 */
export async function usersWhoCanCreateOrganizationApiKeys(
	organizationId: string,
	userIds: string[],
): Promise<Set<string>> {
	return organizationPermissionHoldsForAll(
		organizationId,
		userIds,
		Permissions.ORG_API_KEYS_CREATE,
	);
}
