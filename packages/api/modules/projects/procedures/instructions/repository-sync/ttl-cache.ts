/**
 * A small in-process cache with a time-to-live and a size bound, for answers
 * about a remote repository that are cheap to repeat and costly to refetch on
 * every view (Fizzy #2878 §10). Per process and per deployment instance: a
 * miss is only a provider request, never a wrong answer, so nothing needs to
 * be shared. The oldest entry is dropped first when the bound is reached.
 */
export class TtlCache<V> {
	private readonly entries = new Map<
		string,
		{ value: V; expiresAt: number }
	>();

	constructor(
		private readonly options: {
			ttlMs: number;
			maxEntries: number;
			now?: () => number;
		},
	) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, {
			value,
			expiresAt: this.now() + this.options.ttlMs,
		});
		while (this.entries.size > this.options.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.entries.delete(oldest.value);
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
