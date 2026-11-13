/**
 * Which projects the caller may log and read their own time on.
 *
 * Two conditions, both required:
 *
 *   1. The caller can discover the project: they created it, or hold an
 *      ACTIVE (accepted, unexpired) ProjectMember row. This is
 *      `hasProjectAccess`, the predicate behind the project list and
 *      `projectNotFoundUnlessVisible`. An organization role alone does not
 *      make a project discoverable, so it does not make it loggable either.
 *   2. The caller holds the permission, with the precedence of
 *      `resolveEffectiveProjectPermissions`
 *      (`lib/effective-project-permissions.ts`): an ACTIVE ProjectMember row
 *      is authoritative; otherwise the caller's organization role decides.
 *
 * The single-project procedures get (1) from `projectNotFoundUnlessVisible`
 * or {@link assertProjectVisible} and (2) from the permission middleware.
 * Listing every loggable project, or filtering a month of entries, would cost
 * those lookups once per project, so {@link effectiveProjectPermissions}
 * applies both over rows fetched in one go (`listTimeAccessRows`). Change
 * them together.
 *
 * The personal-project owner path does not apply: these projects all belong
 * to an organization.
 */

import { ORPCError } from "@orpc/server";
import { hasProjectAccess, type TimeAccessMemberRow } from "@repo/database";
import {
	hasPermission,
	type Permission,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../orpc/middleware/project-visibility";

export function effectiveProjectPermissions(params: {
	organizationRole: string | null;
	member: TimeAccessMemberRow | null;
	ownedByCaller: boolean;
	now: Date;
}): readonly Permission[] {
	const { member, now } = params;
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > now);
	if (memberActive) {
		return resolveProjectPermissions(member.role);
	}
	if (params.ownedByCaller) {
		return resolveOrgPermissions(params.organizationRole);
	}
	return [];
}

/**
 * The projects of `rows` on which the caller holds `permission`, by
 * {@link effectiveProjectPermissions}.
 */
export function projectsWithPermission<
	P extends { member: TimeAccessMemberRow | null; ownedByCaller: boolean },
>(
	rows: { organizationRole: string | null; projects: readonly P[] },
	permission: Permission,
	now: Date,
): P[] {
	return rows.projects.filter((project) =>
		hasPermission(
			effectiveProjectPermissions({
				organizationRole: rows.organizationRole,
				member: project.member,
				ownedByCaller: project.ownedByCaller,
				now,
			}),
			permission,
		),
	);
}

/**
 * Refuse a project the caller cannot discover, in the words a missing one
 * gets. For the handlers that learn the project only after loading an entry.
 */
export async function assertProjectVisible(
	projectId: string,
	userId: string,
): Promise<void> {
	if (!(await hasProjectAccess(projectId, userId))) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}
}
