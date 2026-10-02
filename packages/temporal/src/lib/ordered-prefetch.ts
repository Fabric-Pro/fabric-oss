/**
 * Runs `load` over `items` with up to `limit` loads in flight, and `consume`
 * over each loaded value strictly in input order, one at a time.
 *
 * For a loop whose per-item cost is network round trips but whose decisions
 * must stay sequential: the loads overlap, while everything `consume` does
 * (shared counters, bounded lists, writes whose order matters) sees the items
 * exactly as a plain `for` loop would. At most `limit` loaded values are held
 * at once, counting the one being consumed, and each is released once
 * consumed, so memory stays bounded by `limit` items however long the list is.
 *
 * `afterConsume`, when given, runs once per item right after its `consume`
 * returned, with how many items have been fully consumed so far. It never
 * runs for an item whose load or `consume` threw, so the count it reports is
 * work that finished, in input order.
 *
 * On the first error, from a load or from `consume`, no further load starts,
 * every load already started is awaited (settled, its result discarded), and
 * then that first error is thrown. Nothing this call started is still running
 * when it rejects, so a retry of the caller never overlaps a straggler's
 * writes.
 */
export async function forEachPrefetched<T, L>(
	items: readonly T[],
	limit: number,
	load: (item: T, index: number) => Promise<L>,
	consume: (loaded: L, item: T, index: number) => Promise<void> | void,
	afterConsume?: (consumed: number) => Promise<void> | void,
): Promise<void> {
	const width = Math.max(1, Math.floor(limit));
	const queue = items.entries();
	const inFlight = new Map<number, Promise<L>>();
	const fill = () => {
		while (inFlight.size < width) {
			const next = queue.next();
			if (next.done) {
				return;
			}
			const [index, item] = next.value;
			const pending = load(item, index);
			// Observed here so a load that fails while an earlier item is still
			// being consumed is not reported as an unhandled rejection; the
			// error itself is rethrown when its turn comes.
			pending.catch(() => undefined);
			inFlight.set(index, pending);
		}
	};
	for (const [index, item] of items.entries()) {
		fill();
		const pending = inFlight.get(index);
		inFlight.delete(index);
		try {
			if (pending === undefined) {
				throw new Error(
					`Item ${index} was consumed before it was loaded`,
				);
			}
			await consume(await pending, item, index);
			await afterConsume?.(index + 1);
		} catch (error) {
			await Promise.allSettled(inFlight.values());
			throw error;
		}
	}
}
