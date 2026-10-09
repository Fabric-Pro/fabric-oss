import {
	type ChatGptPlanWindow,
	getChatGptPlanOrgAccountWindows,
} from "@repo/database";

/**
 * Shared accounts' current windows, reused briefly by a process (Fizzy
 * #2770): the picker reads them on every pooled call, and a window's usage
 * only moves by a call's worth in this long. Calibration reads them fresh.
 */
export const CHATGPT_PLAN_WINDOW_CACHE_MS = 30_000;

const cache = new Map<
	string,
	{ windows: Promise<Map<string, ChatGptPlanWindow>>; fetchedAt: number }
>();

export function getCachedChatGptPlanOrgAccountWindows(
	organizationId: string,
	accountIds: string[],
	now = Date.now(),
): Promise<Map<string, ChatGptPlanWindow>> {
	const key = `${organizationId}:${[...accountIds].sort().join(",")}`;
	const cached = cache.get(key);
	if (cached && now - cached.fetchedAt < CHATGPT_PLAN_WINDOW_CACHE_MS) {
		return cached.windows;
	}
	const windows = getChatGptPlanOrgAccountWindows({
		organizationId,
		accountIds,
	});
	cache.set(key, { windows, fetchedAt: now });
	windows.catch(() => cache.delete(key));
	return windows;
}

export function __resetChatGptPlanWindowCache(): void {
	cache.clear();
}
