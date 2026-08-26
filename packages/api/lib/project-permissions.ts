/**
 * Permission check for callers outside the oRPC middleware chain.
 *
 * Mirrors `requireProjectPermission` middleware resolution order so callers
 * that cannot install oRPC middleware (e.g. OAuth callback handlers) still
 * enforce the same authorization rules:
 *
 *   1. Personal-project owner: project.userId === userId AND no org.
 *   2. Org role grants the permission via `resolveOrgPermissions` against
 *      the caller's `member.role` on the project's host org.
 *   3. ProjectMember role grants the permission via
 *      `resolveProjectPermissions`, honoring `acceptedAt` and `expiresAt`.
 *
 * Returns false when the project doesn't exist or no path grants access.
 */

import { db } from "@repo/database";
import {
	hasPermission,
	type Permission,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";

export async function userHasProjectPermission(
	projectId: string,
	userId: string,
	permission: Permission,
): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return false;
	}

	if (project.userId === userId && project.organizationId === null) {
		return true;
	}

	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (orgMember) {
			const granted = resolveOrgPermissions(orgMember.role);
			if (hasPermission(granted, permission)) {
				return true;
			}
		}
	}

	const member = await db.projectMember.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	if (!member?.acceptedAt) {
		return false;
	}
	if (member.expiresAt && member.expiresAt < new Date()) {
		return false;
	}
	const projectGranted = resolveProjectPermissions(member.role);
	return hasPermission(projectGranted, permission);
}
