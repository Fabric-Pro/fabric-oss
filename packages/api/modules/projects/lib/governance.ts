/**
 * Project governance helpers (engagement profile, enforcement flags, stage
 * approvers).
 *
 * Plan: docs/features/inverted-loop-delivery-tracks.md §1.2, §3.4,
 * Slice 0.
 */

import { db, type Prisma } from "@repo/database";
import {
	hasPermission,
	type Permission,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";

/**
 * In-handler permission check that follows the exact resolution order of
 * `requireProjectPermission` (packages/api/orpc/middleware/require-permission.ts):
 *
 *   A. Personal-project owner (no org, `project.userId` matches).
 *   B. An **active** ProjectMember row (accepted, non-expired) is
 *      authoritative — an org admin holding a project-level Viewer row
 *      loses the permission on that project. This is intended (§3.4).
 *   C. Fallback to the caller's OrgMember role on the project's host org.
 *
 * Use this when a procedure already carries one permission middleware and a
 * subset of its input needs a stricter permission (e.g. governance fields on
 * `projects.update`). Returns false when the project does not exist.
 */
export async function userHasProjectPermissionStrict(
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

	const member = await db.projectMember.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > new Date());
	if (memberActive) {
		return hasPermission(
			resolveProjectPermissions(member.role),
			permission,
		);
	}

	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (orgMember) {
			return hasPermission(
				resolveOrgPermissions(orgMember.role),
				permission,
			);
		}
	}

	return false;
}

/** Project columns whose change requires PROJECT_GOVERNANCE_MANAGE. */
export const GOVERNANCE_FIELDS = [
	"engagementProfile",
	"enforceSpecifyGate",
	"enforceSpikeGate",
	"enforceDiscoveryGate",
	"documentTiersAdvisory",
	"quotedPhases",
] as const;

export type GovernanceChangeSet = Record<
	string,
	{ before: unknown; after: unknown }
>;

function valuesEqual(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => v === b[i]);
	}
	return a === b;
}

/**
 * Compute `{ field: { before, after } }` for every key in `keys` that the
 * caller supplied (not `undefined`) and that differs from the current value.
 */
export function diffGovernanceFields<K extends string>(
	before: Partial<Record<K, unknown>>,
	after: Partial<Record<K, unknown>>,
	keys: readonly K[],
): GovernanceChangeSet {
	const changed: GovernanceChangeSet = {};
	for (const key of keys) {
		const next = after[key];
		if (next === undefined) {
			continue;
		}
		if (!valuesEqual(before[key], next)) {
			changed[key] = { before: before[key] ?? null, after: next };
		}
	}
	return changed;
}

export interface GovernanceActivityParams {
	projectId: string;
	organizationId: string | null;
	userId: string;
	userName: string;
	/** Project name, stored as `resourceName` for activity feeds. */
	projectName?: string | null;
	changed: GovernanceChangeSet;
}

/**
 * Build (but do not await) the ProjectActivity row for a governance change so
 * callers can run it in the same batch `$transaction` as the mutation it
 * records. `activityType: "governance_changed"`, `resourceType: "project"`.
 */
export function buildGovernanceActivityCreate(
	params: GovernanceActivityParams,
) {
	return db.projectActivity.create({
		data: {
			projectId: params.projectId,
			userId: params.userId,
			userName: params.userName,
			activityType: "governance_changed",
			resourceType: "project",
			resourceId: params.projectId,
			resourceName: params.projectName ?? undefined,
			organizationId: params.organizationId,
			metadata: { changed: params.changed } as Prisma.InputJsonValue,
		},
	});
}

/** Display name for activity rows; never empty. */
export function activityUserName(user: {
	name?: string | null;
	email?: string | null;
}): string {
	return user.name?.trim() || user.email?.trim() || "Unknown user";
}
