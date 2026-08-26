/**
 * Temporal activity for automatic semantic duplicate detection.
 *
 * Thin wrapper over `detectAndFlagDuplicateStories` so it runs as a retried
 * Temporal activity (driven by the fire-and-forget `detectDuplicates`
 * workflow). The underlying function THROWS on transient embedding/LLM/DB
 * failures — that is intentional here: a thrown activity is retried by the
 * workflow's retry policy with backoff, which is what makes detection resilient
 * to rate-limit blips under burst load (e.g. approving many proposals at once),
 * instead of silently swallowing the failure.
 */

import {
	type DetectDuplicateStoriesParams,
	type DetectDuplicateStoriesResult,
	detectAndFlagDuplicateStories,
} from "../lib/detect-duplicate-stories";

export type {
	DetectDuplicateStoriesParams,
	DetectDuplicateStoriesResult,
} from "../lib/detect-duplicate-stories";

export async function detectDuplicateStoriesActivity(
	params: DetectDuplicateStoriesParams,
): Promise<DetectDuplicateStoriesResult> {
	return detectAndFlagDuplicateStories(params);
}
