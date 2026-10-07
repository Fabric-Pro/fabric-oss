/** The settled outcome of a promise, so concurrent steps can fail in a fixed order. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

export function unsettle<T>(settled: Settled<T>): T {
	if (!settled.ok) {
		throw settled.error;
	}
	return settled.value;
}
