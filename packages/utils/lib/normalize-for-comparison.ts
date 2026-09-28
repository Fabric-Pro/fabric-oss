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

/**
 * Drop the backslash from an escaped ordered marker at the start of a line:
 * the editor's serializer writes `38\. GIVEN` for a paragraph that reads like
 * an ordered item. Shared by the regular export (which renders the text) and
 * the Glossy cache keys (which must not re-key on the escape alone).
 */
export function normalizeOrderedMarkerEscape(text: string): string {
	return text.replace(/^(\s*)(\d+)\\\.(\s)/, "$1$2.$3");
}
