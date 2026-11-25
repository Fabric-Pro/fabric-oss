/**
 * Project governance helpers (engagement profile, enforcement flags, stage
 * approvers).
 *
 * Plan: docs/features/inverted-loop-delivery-tracks.md §1.2, §3.4,
 * Slice 0.
 */

import { db, type Prisma } from "@repo/database";
import type { Permission } from "@repo/permissions";
import { resolveProjectPermissionDecision } from "../../../lib/project-permission-decision";

/** Additional in-handler permission check that propagates lookup errors. */
export async function userHasProjectPermissionStrict(
	projectId: string,
	userId: string,
	permission: Permission,
): Promise<boolean> {
	return (
		await resolveProjectPermissionDecision({
			projectId,
			userId,
			permission,
		})
	).allowed;
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
