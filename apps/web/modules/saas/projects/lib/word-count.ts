/**
 * Combined word count of a work item's title + description, used on every
 * column of the PM-sync conflict dialog so reviewers can gauge how much content
 * each side carries. Whitespace-delimited tokens of the raw text; markdown
 * syntax is counted as-is (no stripping) for v1. Empty content → 0.
 */
export function countWords(title: string, description: string): number {
	return `${title} ${description}`.trim().split(/\s+/).filter(Boolean).length;
}

/** Renders a word count as "0 words" / "1 word" / "{n} words". */
export function formatWordCount(count: number): string {
	return `${count} ${count === 1 ? "word" : "words"}`;
}
