import { getChatGptPlanServedModels } from "@repo/database";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceStateKey,
} from "./sources";

// Every plan-served call resolves its model against the stored list, so a
// process reuses it briefly; a refresh or sign-in change in this process
// replaces it at once, and one in another process applies within this long.
const SERVED_SLUGS_CACHE_MS = 60_000;
const slugCache = new Map<
	string,
	{ slugs: Set<string> | null; fetchedAt: number; generation: number }
>();
// Bumped by every invalidation. Each entry is stamped with the generation it
// was stored under and is ignored under any other, so a bump retires whatever
// was cached before it, and a read that began before one does not store what
// it read (Fizzy #3037).
const generations = new Map<string, number>();

function generationOf(key: string): number {
	return generations.get(key) ?? 0;
}

/**
 * The slugs this source served when last checked, or null when it was never
 * checked (or the lookup failed) — then nothing is known to be unserved.
 */
export async function chatGptPlanServedSlugs(
	source: PlanSourceRef,
	now = Date.now(),
): Promise<Set<string> | null> {
	const key = planSourceKey(source);
	const generation = generationOf(key);
	const cached = slugCache.get(key);
	if (
		cached?.generation === generation &&
		now - cached.fetchedAt < SERVED_SLUGS_CACHE_MS
	) {
		return cached.slugs;
	}
	try {
		const rows = await getChatGptPlanServedModels([
			planSourceStateKey(source),
		]);
		const slugs =
			rows.length > 0 ? new Set(rows.map((row) => row.slug)) : null;
		if (generationOf(key) === generation) {
			slugCache.set(key, { slugs, fetchedAt: now, generation });
		}
		return slugs;
	} catch {
		return null;
	}
}

/** Reload this source's served models on its next read. */
export function invalidateChatGptPlanServedSlugs(source: PlanSourceRef): void {
	const key = planSourceKey(source);
	generations.set(key, generationOf(key) + 1);
	// The bump already retires the entry; deleting it frees it now, since a
	// disconnected source may never be read again.
	slugCache.delete(key);
}

export function __resetChatGptPlanServedSlugs(): void {
	slugCache.clear();
	generations.clear();
}
