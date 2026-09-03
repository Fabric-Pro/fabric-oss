/**
 * Work-Item Title Normalization
 *
 * Pure, deterministic write-time normalizers applied on the AI Update path so
 * the stored `UserStory.title` / `UserStory.description` are clean once
 * persisted. Every downstream surface (roadmap UI, story detail header,
 * markdown export, PM sync, MCP/RAG context) then inherits clean data.
 *
 * IMPORTANT: These are NOT `normalizeBacklogTitle`
 * (packages/database/utils.ts). That helper lowercases, trims, and strips only
 * a leading `[bug]` for dedup equivalence-class matching — it destroys display
 * casing and does not cover the full prefix set. `stripWorkItemTitlePrefix`
 * below preserves casing and covers all four work-item kinds; it must not be
 * swapped for `normalizeBacklogTitle`.
 */

/**
 * Leading work-item prefix, case-insensitive and anchored. Matches one
 * bracketed prefix (`[bug]`, `[feature]`, `[story]`, `[epic]`) OR one
 * colon-suffixed prefix (`bug:`, `feature:`, `story:`, `epic:`), surrounded by
 * optional whitespace. Applied repeatedly so back-to-back / mixed prefixes
 * (`Bug: [BUG] …`) all strip.
 */
const LEADING_WORK_ITEM_PREFIX =
	/^\s*(?:\[(?:bug|feature|story|epic)\]|(?:bug|feature|story|epic):)\s*/i;

/**
 * ATX H1 on a single line: a leading `#`, at least one space, the heading
 * text, and an optional trailing closing `#` sequence. Capture group 1 is the
 * heading text.
 */
const ATX_H1_LINE = /^#\s+(.+?)\s*#*\s*$/;

/**
 * Strip a leading work-item title prefix from `title`, repeatedly and
 * case-insensitively, preserving the casing of the remaining text.
 *
 * Strips the leading prefix set — bracketed (`[BUG]`, `[FEATURE]`, `[STORY]`,
 * `[EPIC]`) and colon-suffixed (`Bug:`, `Feature:`, `Story:`, `Epic:`) — until
 * no leading prefix remains, then trims. Only LEADING prefixes are removed; a
 * prefix-like token mid-string (`Fix the [BUG] handler`) is left intact.
 *
 * Idempotent: `f(f(x)) === f(x)`. A title that is only prefixes returns `""`;
 * callers keep their own empty-title fallbacks.
 *
 * NOTE: This is deliberately NOT `normalizeBacklogTitle` — it must NOT
 * lowercase the result. `[BUG] No Output Generated` → `No Output Generated`.
 */
export function stripWorkItemTitlePrefix(title: string): string {
	let result = title;
	while (LEADING_WORK_ITEM_PREFIX.test(result)) {
		result = result.replace(LEADING_WORK_ITEM_PREFIX, "");
	}
	return result.trim();
}

/**
 * Remove a leading markdown ATX H1 from `body` ONLY when that heading
 * duplicates `title` after both are run through `stripWorkItemTitlePrefix` and
 * compared case-insensitively (trimmed).
 *
 * Operates on the first non-empty line only: leading blank lines are ignored
 * for detection. When the leading H1's key equals the title's key, the H1 line
 * (and any leading blank lines before it, plus a single immediately-following
 * blank line) is removed and the remainder of the body is preserved
 * byte-for-byte. In every other case (`body` has no leading H1, the first
 * heading is an H2, the heading does not match the title) `body` is returned
 * unchanged. Subsequent headings are never touched.
 *
 * This is what removes the `# Bug: <title>` duplicate-H1 shape (B-020): both
 * the heading text and the title lose their prefixes before comparison, so a
 * `# Bug:`-prefixed heading still matches a prefix-stripped title.
 */
export function stripLeadingDuplicateTitleHeading(
	body: string,
	title: string,
): string {
	if (!body) {
		return body;
	}

	const lines = body.split("\n");
	let headingIndex = 0;
	while (headingIndex < lines.length && lines[headingIndex].trim() === "") {
		headingIndex += 1;
	}
	if (headingIndex >= lines.length) {
		return body;
	}

	// Bounded span: js/polynomial-redos — `body` is unbounded AI-Update story
	// content with no length cap; a real ATX heading line is never this long.
	const MAX_HEADING_LINE_CHARS = 2000;
	const headingMatch = lines[headingIndex]
		.slice(0, MAX_HEADING_LINE_CHARS)
		.match(ATX_H1_LINE);
	if (!headingMatch) {
		return body;
	}

	const headingKey = stripWorkItemTitlePrefix(headingMatch[1]).toLowerCase();
	const titleKey = stripWorkItemTitlePrefix(title).toLowerCase();
	if (headingKey !== titleKey) {
		return body;
	}

	// Drop everything up to and including the H1 line, then collapse a single
	// immediately-following blank line.
	let nextIndex = headingIndex + 1;
	if (nextIndex < lines.length && lines[nextIndex].trim() === "") {
		nextIndex += 1;
	}
	return lines.slice(nextIndex).join("\n");
}
