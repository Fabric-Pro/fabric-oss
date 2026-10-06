/**
 * Run a bounded pool that drains work already started after the first failure.
 *
 * Returning as soon as one worker rejects leaves its peers live while a caller
 * starts cleanup or a retry. Stop claiming new items, await every started
 * operation, then rethrow the first failure instead.
 */
export async function runDrainingPool<T>(
	items: readonly T[],
	width: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) {
		return;
	}
	if (width < 1) {
		throw new RangeError("A draining pool needs at least one worker");
	}
	const iterator = items[Symbol.iterator]();
	let firstError: { value: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (firstError === undefined) {
			const next = iterator.next();
			if (next.done) {
				return;
			}
			try {
				await fn(next.value);
			} catch (error) {
				firstError ??= { value: error };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(width, items.length) }, () => worker()),
	);
	if (firstError !== undefined) {
		throw firstError.value;
	}
}
