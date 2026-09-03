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
 * The ids are server-written by the 1A contributor resolver from the project's
 * own stories and documents, so this is a name lookup for people the topic
 * already names — not a membership query. Skipped entirely when the list is
 * empty, which is both common and valid.
 *
 * Extracted here because all three generation families — planning analysis,
 * short post, blog post — had carried a byte-identical private copy, and Phase
 * 2C adds two more content types: five copies would be five places for the
 * caveat above to rot out of sync, and that caveat is the whole reason an
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
