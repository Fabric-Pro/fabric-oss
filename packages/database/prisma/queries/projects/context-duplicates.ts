/**
 * Which project context rows duplicate another row's content (Fizzy #2619).
 *
 * Duplicates are accepted when they are written and derived here, at read
 * time, from `contentHash`. Nothing stores a pointer from a copy to its
 * original, so the answer heals itself: delete the canonical row and the next
 * read promotes one of the remaining copies, and rows written before hashes
 * existed join in as soon as the backfill stamps them.
 *
 * Pure (no Prisma), so the list procedure can annotate exactly the rows it is
 * about to return — a canonical row must be one the caller can see.
 */

export interface ContextDuplicateCandidate {
	id: string;
	contentHash: string | null;
	sourcePath: string | null;
	createdAt: Date | string;
	/**
	 * Set when a Living Memory repository sync manages the row. Optional so
	 * a caller holding rows without the column still type-checks; absent is
	 * read as unmanaged.
	 */
	repositorySyncId?: string | null;
}

function createdAtMs(row: ContextDuplicateCandidate): number {
	const ms = new Date(row.createdAt).getTime();
	// An unparseable date sorts last rather than poisoning the comparison.
	return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Order two rows sharing a hash by which one should be kept. A row a
 * repository sync manages wins first (Living Memory design 2026-09-23 §7.3):
 * no other surface may delete it, so Remove duplicates must never be offered
 * it as a copy. Then a synced file (`sourcePath` set): it is system-managed,
 * and removing it would only have the next push put it back. Then the
 * earliest `createdAt`, then the smallest id, so the choice is stable across
 * reads.
 */
function compareCanonical(
	a: ContextDuplicateCandidate,
	b: ContextDuplicateCandidate,
) {
	const aManaged = Boolean(a.repositorySyncId);
	const bManaged = Boolean(b.repositorySyncId);
	if (aManaged !== bManaged) {
		return aManaged ? -1 : 1;
	}
	const aSynced = a.sourcePath !== null && a.sourcePath !== "";
	const bSynced = b.sourcePath !== null && b.sourcePath !== "";
	if (aSynced !== bSynced) {
		return aSynced ? -1 : 1;
	}
	const aCreated = createdAtMs(a);
	const bCreated = createdAtMs(b);
	if (aCreated !== bCreated) {
		return aCreated < bCreated ? -1 : 1;
	}
	if (a.id === b.id) {
		return 0;
	}
	return a.id < b.id ? -1 : 1;
}

/**
 * Map every duplicate row's id to the id of the row it duplicates.
 *
 * Rows with no hash (nothing extracted yet, or written before hashes existed
 * and not yet backfilled) are never grouped. Within a group of rows sharing a
 * hash, exactly one row is canonical and absent from the map; every other row
 * in the group maps to it.
 */
export function annotateDuplicateContexts<T extends ContextDuplicateCandidate>(
	rows: readonly T[],
): Map<string, string> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		if (!row.contentHash) {
			continue;
		}
		const group = groups.get(row.contentHash);
		if (group) {
			group.push(row);
		} else {
			groups.set(row.contentHash, [row]);
		}
	}

	const duplicateOf = new Map<string, string>();
	for (const group of groups.values()) {
		if (group.length < 2) {
			continue;
		}
		const [canonical, ...copies] = [...group].sort(compareCanonical);
		if (!canonical) {
			continue;
		}
		for (const copy of copies) {
			duplicateOf.set(copy.id, canonical.id);
		}
	}
	return duplicateOf;
}
