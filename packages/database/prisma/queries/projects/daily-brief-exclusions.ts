/**
 * Database queries for per-project Daily Brief release-notes exclusions
 * (Fizzy 1869 follow-up — hide flag-gated PRs/stories from the release-notes
 * panel and the newsletter by PR or story identifier).
 *
 * Uses the raw `db` client (BYPASSRLS); callers pass tenant columns explicitly.
 */
import type { db, Prisma } from "../../client";

export type ReleaseNoteExclusionTenant = {
	projectId: string;
	organizationId: string | null;
	userId: string;
};

export type ReleaseNoteExclusionInput =
	| { kind: "pr"; repoFullName: string; prNumber: number; reason?: string }
	| { kind: "story"; storyIdentifier: string; reason?: string };

function tenantWhere(t: ReleaseNoteExclusionTenant) {
	return t.organizationId
		? { projectId: t.projectId, organizationId: t.organizationId }
		: { projectId: t.projectId, organizationId: null, userId: t.userId };
}

export function buildExclusionTargetKey(
	input: ReleaseNoteExclusionInput,
): string {
	return input.kind === "pr"
		? `pr:${input.repoFullName}#${input.prNumber}`
		: `story:${input.storyIdentifier}`;
}

const SELECT = {
	id: true,
	kind: true,
	repoFullName: true,
	prNumber: true,
	storyIdentifier: true,
	reason: true,
	excludedByUserId: true,
	createdAt: true,
} as const;

export async function createReleaseNoteExclusion(
	client: Prisma.TransactionClient | typeof db,
	tenant: ReleaseNoteExclusionTenant,
	input: ReleaseNoteExclusionInput,
	excludedByUserId: string,
) {
	const targetKey = buildExclusionTargetKey(input);
	// ATOMIC + idempotent + transaction-safe: createMany(skipDuplicates) compiles to
	// INSERT ... ON CONFLICT DO NOTHING — it does NOT throw on a unique conflict (so it
	// never poisons an enclosing $transaction the way a create()→P2002 would), and its
	// `count` distinguishes created (1) from already-present (0) under concurrent hides.
	const { count } = await client.dailyBriefReleaseNoteExclusion.createMany({
		data: [
			{
				projectId: tenant.projectId,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				kind: input.kind,
				targetKey,
				repoFullName: input.kind === "pr" ? input.repoFullName : null,
				prNumber: input.kind === "pr" ? input.prNumber : null,
				storyIdentifier:
					input.kind === "story" ? input.storyIdentifier : null,
				reason: input.reason ?? null,
				excludedByUserId,
			},
		],
		skipDuplicates: true,
	});
	const row = await client.dailyBriefReleaseNoteExclusion.findUnique({
		where: {
			projectId_targetKey: { projectId: tenant.projectId, targetKey },
		},
		select: SELECT,
	});
	return { created: count === 1, row: row! }; // row is always present after the insert/skip
}

export async function deleteReleaseNoteExclusion(
	client: Prisma.TransactionClient | typeof db,
	tenant: ReleaseNoteExclusionTenant,
	id: string,
) {
	// Fetch the scoped row FIRST so the (hard-deleted) target survives in the audit trail;
	// then delete via a scoped deleteMany so only the winner of a concurrent unhide gets
	// count===1 (and therefore emits exactly one audit row).
	const row = await client.dailyBriefReleaseNoteExclusion.findFirst({
		where: { id, ...tenantWhere(tenant) },
		select: { ...SELECT, targetKey: true },
	});
	if (!row) {
		return { deleted: false as const };
	}
	const { count } = await client.dailyBriefReleaseNoteExclusion.deleteMany({
		where: { id, ...tenantWhere(tenant) },
	});
	if (count === 0) {
		return { deleted: false as const }; // lost a concurrent race
	}
	return { deleted: true as const, row };
}

export async function listReleaseNoteExclusions(
	client: typeof db,
	tenant: ReleaseNoteExclusionTenant,
) {
	return client.dailyBriefReleaseNoteExclusion.findMany({
		where: tenantWhere(tenant),
		select: SELECT,
		orderBy: { createdAt: "desc" },
	});
}
