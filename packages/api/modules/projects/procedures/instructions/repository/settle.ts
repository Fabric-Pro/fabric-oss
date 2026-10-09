type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

function unsettle<T>(settled: Settled<T>): T {
	if (!settled.ok) {
		throw settled.error;
	}
	return settled.value;
}

/**
 * Two steps that run together but fail in a fixed order: both settle, then
 * the earliest-declared failure is the one thrown, whichever failed first.
 * Plain `Promise.all` would answer with whichever rejected first, and leave
 * the other still running.
 */
export async function inOrder<A, B>(
	first: Promise<A>,
	second: Promise<B>,
): Promise<[A, B]> {
	const [a, b] = await Promise.all([settle(first), settle(second)]);
	return [unsettle(a), unsettle(b)];
}
