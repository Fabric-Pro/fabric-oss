/**
 * Normalize content for comparison purposes only.
 * Handles differences introduced by the HTML→Markdown roundtrip
 * (TipTap → Turndown → Markdown) which is NOT idempotent.
 *
 * This is the canonical "is this a no-op" comparator: the save layer
 * (`updateDocument`) uses it to decide whether content actually changed,
 * so any layer judging no-ops must use the same semantics.
 */
export function normalizeForComparison(content: string): string {
	return content
		.replace(/\r\n/g, "\n") // Normalize line endings
		.replace(/[ \t]+$/gm, "") // Trim trailing whitespace per line
		.replace(/\n{3,}/g, "\n\n") // Collapse 3+ newlines into 2
		.trim();
}
