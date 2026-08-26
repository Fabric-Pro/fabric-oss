import { db } from "../client";

/**
 * Who can decide a nomination, and therefore who should be told one is waiting.
 *
 * FR16. Deliberately the same authority the API enforces at approval time
 * (`assertMayReviewAtScope`), because telling someone about a queue they cannot
 * act on is worse than silence — it is a notification whose only possible
 * outcome is a permission error.
 *
 * The two tiers resolve through different fields, which is the trap:
 *
 *   - SYSTEM is the PLATFORM admin, `User.role === "admin"`. Not org owners.
 *     A universal default is inherited by every tenant that has not overridden
 *     it, so no amount of authority inside one organization qualifies.
 *   - ORG is `Member.role in (admin, owner)` for that one organization.
 */

export type NominationReviewer = {
	userId: string;
	/** Null for a system-tier nomination; it belongs to no organization. */
	organizationId: string | null;
};

export async function listPromptNominationReviewers({
	targetScope,
	organizationId,
	excludeUserId,
}: {
	targetScope: "SYSTEM" | "ORG";
	organizationId?: string | null;
	/** The nominator: they know, and telling them is noise. */
	excludeUserId?: string;
}): Promise<NominationReviewer[]> {
	if (targetScope === "SYSTEM") {
		const admins = await db.user.findMany({
			where: { role: "admin" },
			select: { id: true },
		});
		return admins
			.filter((a) => a.id !== excludeUserId)
			.map((a) => ({ userId: a.id, organizationId: null }));
	}

	if (!organizationId) {
		return [];
	}

	const members = await db.member.findMany({
		where: { organizationId, role: { in: ["admin", "owner"] } },
		select: { userId: true, organizationId: true },
	});

	// One row per user: a person can hold only one membership per organization,
	// but de-duplicating here keeps the caller honest about its count.
	const seen = new Set<string>();
	const reviewers: NominationReviewer[] = [];
	for (const member of members) {
		if (member.userId === excludeUserId || seen.has(member.userId)) {
			continue;
		}
		seen.add(member.userId);
		reviewers.push({
			userId: member.userId,
			organizationId: member.organizationId,
		});
	}
	return reviewers;
}
