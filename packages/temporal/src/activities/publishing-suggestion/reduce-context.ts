export interface Decayable<T> {
	updatedAtIso: string;
	payload: T;
}

const HALF_LIFE_DAYS = 30;

export function decayOrderAndTruncate<T>(
	items: Decayable<T>[],
	now: Date,
	budget: number,
): T[] {
	const scored = items.map((it) => {
		const ageDays =
			(now.getTime() - new Date(it.updatedAtIso).getTime()) / 86_400_000;
		const score = 0.5 ** (Math.max(0, ageDays) / HALF_LIFE_DAYS);
		return { score, payload: it.payload };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, budget).map((s) => s.payload);
}
