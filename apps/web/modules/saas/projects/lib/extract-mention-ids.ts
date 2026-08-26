const MENTION_ID_PATTERN = /data-type="mention"[^>]*data-id="([^"]+)"/g;

/**
 * Extract unique @mention user IDs from a TipTap HTML string.
 *
 * Looks for spans with `data-type="mention"` and reads their `data-id`
 * attribute. Used by the document editor to build the initial set of IDs
 * to pass to `resolveActiveMentions` on mount.
 */
export function extractMentionIdsFromHtml(
	html: string | null | undefined,
): string[] {
	if (!html) {
		return [];
	}
	const seen = new Set<string>();
	let match: RegExpExecArray | null;
	const re = new RegExp(MENTION_ID_PATTERN.source, "g");
	while ((match = re.exec(html)) !== null) {
		seen.add(match[1]);
	}
	return Array.from(seen);
}
