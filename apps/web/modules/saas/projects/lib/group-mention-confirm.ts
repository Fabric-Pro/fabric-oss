import { GROUP_SLUG_TO_TAG } from "@repo/database/src/function-tags";

const GROUP_TOKEN_PATTERN = /(^|\s)@@([a-z][a-z0-9-]{1,40})(?=$|\s|[:,.!?])/gi;

/**
 * The recipient count above which a fan-out is confirmed rather than sent
 * outright.
 *
 * Exported because the CLI-connection ask (Fizzy #2457) shares this exact
 * number for its own hand-picked-recipient confirm — see
 * `LARGE_ASK_THRESHOLD` in `@saas/projects/components/cli-connection/lib/cli-connection-nudge`
 * — and a product rule about how many people may be notified without a
 * second look is one number, not two coincidentally-equal ones.
 */
export const LARGE_GROUP_THRESHOLD = 10;

/**
 * Evaluate whether a comment addresses a group large enough to warrant a
 * "Notify N people?" confirm. Pure — the caller supplies the counts fetched
 * from `functionTags.groupMemberCounts`.
 */
export function evaluateLargeGroupConfirm(
	content: string,
	counts: Record<string, number>,
	threshold: number = LARGE_GROUP_THRESHOLD,
): { addressedTags: string[]; maxCount: number; needsConfirm: boolean } {
	const tags = new Set<string>();
	for (const match of content.matchAll(GROUP_TOKEN_PATTERN)) {
		const tag = GROUP_SLUG_TO_TAG[match[2]?.toLowerCase() ?? ""];
		if (tag) {
			tags.add(tag);
		}
	}
	const addressedTags = [...tags];
	const maxCount = addressedTags.reduce(
		(max, tag) => Math.max(max, counts[tag] ?? 0),
		0,
	);
	return { addressedTags, maxCount, needsConfirm: maxCount > threshold };
}
