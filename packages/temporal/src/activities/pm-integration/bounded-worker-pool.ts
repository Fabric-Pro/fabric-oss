/**
 * Bounded worker-pool with an optional absolute deadline.
 *
 * Spawns up to `concurrency` workers that share a cursor and run `task(idx)`
 * for each index in `[0, total)`. A worker stops pulling new work once
 * `now() >= deadlineAt` (an ABSOLUTE epoch-ms deadline the caller computes from
 * its OWN entry, so any pre-pool work is already charged against it — DEC-7), so
 * the pool returns before the caller's hard deadline. In-flight tasks are NOT
 * interrupted — the caller is responsible for bounding each `task` (e.g. a
 * per-call timeout).
 *
 * Returns the indices that were never attempted (because the deadline was hit),
 * in ascending order, so the caller can mark them appropriately (e.g. as a
 * transient failure).
 *
 * `now` is injectable for deterministic tests; it defaults to `Date.now`.
 */
export async function runBoundedWorkerPool(opts: {
	total: number;
	concurrency: number;
	deadlineAt?: number;
	now?: () => number;
	task: (idx: number) => Promise<void>;
}): Promise<{ skipped: number[] }> {
	const { total, concurrency, deadlineAt, now = Date.now, task } = opts;
	if (total <= 0) {
		return { skipped: [] };
	}
	const pastDeadline = () => deadlineAt !== undefined && now() >= deadlineAt;

	const workerCount = Math.max(1, Math.min(concurrency, total));
	const cursor = { next: 0 };
	const attempted = new Set<number>();

	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			if (pastDeadline()) {
				return;
			}
			const idx = cursor.next++;
			if (idx >= total) {
				return;
			}
			attempted.add(idx);
			await task(idx);
		}
	});
	await Promise.all(workers);

	const skipped: number[] = [];
	for (let i = 0; i < total; i++) {
		if (!attempted.has(i)) {
			skipped.push(i);
		}
	}
	return { skipped };
}
