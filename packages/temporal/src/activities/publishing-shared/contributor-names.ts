/**
 * Contributor name lookup shared by the publishing generation families.
 *
 * Not an activity, and deliberately not reachable from the worker's activity
 * barrel: it is a bare database read, and registering it would hand Temporal a
 * schedulable `db.user.findMany` with no tenant argument of its own.
 */

import { db } from "@repo/database";

/**
 * Display names for the topic's already-resolved contributors.
 *
 * The ids come from `effectiveContributorUserIds` — either the 1A resolver's
 * answer from the project's own stories and documents, or a user override.
 * `updateTopicContributors` admits into an override only ids that were project
 * members AT WRITE TIME, which is what keeps this an unscoped NAME LOOKUP for
 * people the topic already names rather than a directory query. Two limits of
 * that guarantee, stated so nobody has to rediscover them:
 *   - it is a write-time check, so removing a member does NOT prune the ids
 *     they already appear in — a former member's name still resolves here;
 *   - it is the ONLY check. A new writer of `userContributorUserIds` that
 *     skips it turns this read into a name-disclosure oracle for arbitrary
 *     user ids, and this lookup would then have to be scoped instead.
 *
 * Skipped entirely when the list is empty, which is both common and valid.
 *
 * Extracted here because all three generation families — planning analysis,
 * short post, blog post — had carried a byte-identical private copy, and Phase
 * 2C adds two more content types: five copies would be five places for the
 * caveats above to rot out of sync, and those caveats are the whole reason an
 * unscoped read on the base client is acceptable here at all.
 */
export async function resolveContributorNames(
	contributorUserIds: string[],
): Promise<{ id: string; name: string | null }[]> {
	if (contributorUserIds.length === 0) {
		return [];
	}
	const users = await db.user.findMany({
		where: { id: { in: contributorUserIds } },
		select: { id: true, name: true },
	});
	return users.map((u) => ({ id: u.id, name: u.name ?? null }));
}
