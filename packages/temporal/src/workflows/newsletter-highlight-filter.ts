import type { NewsletterContent } from "@repo/database";

/** Return a copy of `content` with the highlights at `removedIndexes` dropped.
 *  Indexes are positions into content.highlights (the only stable identity — a
 *  highlight has no id). Empty result ⇒ hasMajorFeatures=false so the caller
 *  finalizes SKIPPED_EMPTY ("no user-visible changes", FR4). */
export function applyRemovedHighlights(
	content: NewsletterContent,
	removedIndexes: number[],
): NewsletterContent {
	const drop = new Set(removedIndexes);
	const highlights = content.highlights.filter((_, i) => !drop.has(i));
	return {
		...content,
		highlights,
		hasMajorFeatures: content.hasMajorFeatures && highlights.length > 0,
	};
}
