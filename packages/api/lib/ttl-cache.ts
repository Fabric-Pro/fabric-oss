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
		{ value: V; expiresAt: number; weight: number }
	>();
	private totalWeight = 0;

	constructor(
		private readonly options: {
			ttlMs: number;
			maxEntries: number;
			/**
			 * Bound the memory a few large values can hold: the sum of `weigh`
			 * over the entries stays at or under `maxWeight`, and a value that
			 * alone exceeds it is not kept.
			 */
			weigh?: (value: V) => number;
			maxWeight?: number;
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
			this.remove(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V): void {
		const weight = this.options.weigh?.(value) ?? 0;
		this.remove(key);
		if (
			this.options.maxWeight !== undefined &&
			weight > this.options.maxWeight
		) {
			return;
		}
		this.entries.set(key, {
			value,
			expiresAt: this.now() + this.options.ttlMs,
			weight,
		});
		this.totalWeight += weight;
		while (
			this.entries.size > this.options.maxEntries ||
			(this.options.maxWeight !== undefined &&
				this.totalWeight > this.options.maxWeight)
		) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.remove(oldest.value);
		}
	}

	clear(): void {
		this.entries.clear();
		this.totalWeight = 0;
	}

	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (entry !== undefined) {
			this.totalWeight -= entry.weight;
			this.entries.delete(key);
		}
	}
}
