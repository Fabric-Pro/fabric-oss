/** Minimal shape the threading helper needs from a comment. */
export type ThreadableComment = {
	id: string;
	parentId?: string | null;
};

export type ThreadedComment<T extends ThreadableComment> = T & {
	replies: T[];
};

/**
 * Group a flat, chronologically-ordered comment list into single-level
 * threads. Each comment is resolved to its thread root by walking the
 * `parentId` chain to the top; roots render in input order, with their
 * replies nested exactly one level beneath them (a reply-to-a-reply
 * collapses to the same root). Never drops a comment: an orphan whose
 * parent is absent from the list (e.g. a soft-deleted parent) becomes its
 * own root. The walk is cycle-safe, and resolved root ids are memoized so
 * grouping stays O(n) even for long reply-to-reply chains.
 */
export function groupCommentsIntoThreads<T extends ThreadableComment>(
	comments: T[],
): ThreadedComment<T>[] {
	const byId = new Map<string, T>();
	for (const comment of comments) {
		byId.set(comment.id, comment);
	}

	// Memoize each comment's resolved thread-root id so the `parentId` chain is
	// walked at most once per node across both passes. Cycle walks are
	// deliberately NOT cached: a node's resolution inside a cycle is
	// path-dependent, whereas an acyclic node's root is fixed regardless of
	// entry point — so only acyclic results are safe to memoize.
	const rootIdCache = new Map<string, string>();
	const rootIdOf = (start: T): string => {
		const cachedStart = rootIdCache.get(start.id);
		if (cachedStart !== undefined) {
			return cachedStart;
		}
		const path: string[] = [];
		const seen = new Set<string>();
		let current = start;
		while (
			current.parentId &&
			byId.has(current.parentId) &&
			!seen.has(current.id)
		) {
			const known = rootIdCache.get(current.id);
			if (known !== undefined) {
				// Reached an already-resolved node — every node we crossed
				// shares its root.
				for (const id of path) {
					rootIdCache.set(id, known);
				}
				return known;
			}
			seen.add(current.id);
			path.push(current.id);
			current = byId.get(current.parentId) as T;
		}
		if (seen.has(current.id)) {
			// Cycle: return the loop-back node id without caching (the result is
			// path-dependent, so it must not pollute the cache for other starts).
			return current.id;
		}
		// Genuine root reached via an acyclic path: every node on the path (and
		// the root itself) resolves to it.
		const rootId = current.id;
		for (const id of path) {
			rootIdCache.set(id, rootId);
		}
		rootIdCache.set(rootId, rootId);
		return rootId;
	};

	const roots: ThreadedComment<T>[] = [];
	const rootsById = new Map<string, ThreadedComment<T>>();

	// Pass 1: collect roots in input order.
	for (const comment of comments) {
		if (rootIdOf(comment) === comment.id) {
			const threaded: ThreadedComment<T> = { ...comment, replies: [] };
			roots.push(threaded);
			rootsById.set(comment.id, threaded);
		}
	}

	// Pass 2: attach each non-root comment to its resolved root.
	for (const comment of comments) {
		const rootId = rootIdOf(comment);
		if (rootId !== comment.id) {
			rootsById.get(rootId)?.replies.push(comment);
		}
	}

	return roots;
}
