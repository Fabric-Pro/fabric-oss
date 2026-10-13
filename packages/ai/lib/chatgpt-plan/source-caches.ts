import { invalidateChatGptPlanSourceExhaustion } from "./exhaustion-breaker";
import { invalidateChatGptPlanServedSlugs } from "./served-slugs";
import type { PlanSourceRef } from "./sources";

/**
 * Forgets what this process cached about a source whose sign-in just changed
 * or went away — its spent window and its served models — so the next read
 * loads the source's current rows. Other processes catch up when their own
 * short caches expire.
 */
export function invalidateChatGptPlanSourceCaches(source: PlanSourceRef): void {
	invalidateChatGptPlanSourceExhaustion(source);
	invalidateChatGptPlanServedSlugs(source);
}
