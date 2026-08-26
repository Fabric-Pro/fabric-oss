/**
 * Reduce Markdown source to readable plain text for space-constrained previews
 * (e.g. `line-clamp-2` proposal cards and inbox summaries) where rendering
 * block-level Markdown would blow out the layout.
 *
 * This is a lightweight, best-effort strip — it targets the syntax LLM-authored
 * proposal bodies actually emit (bold, italic, headings, lists, inline code,
 * links, blockquotes, pipe tables), not a full CommonMark parse. It is pure and
 * total: it never throws and returns readable text for any input, including
 * malformed Markdown such as an unclosed `**`.
 *
 * For full rendering (view/read surfaces), use the `<Markdown>` component
 * instead — this helper is only for truncated previews.
 */
export function stripMarkdown(input: string | null | undefined): string {
	if (!input) {
		return "";
	}

	// Cap input before the regex passes. Callers only ever show the result in
	// a 2-line clamp, so a few KB is far more than enough — and it bounds cost
	// to a constant. Without this, a single long line of space-separated
	// underscores (`_a _a _a …`) makes the boundary-anchored underscore-
	// emphasis regex O(n^2) (each opener rescans its whole line and never
	// pairs), which is main-thread-blockable on unbounded @db.Text input.
	let text = input.length > 4000 ? input.slice(0, 4000) : input;

	// Fenced code blocks -> keep inner text, drop the ``` fences.
	text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
	// Inline code -> drop the backticks.
	text = text.replace(/`([^`]+)`/g, "$1");
	// Images ![alt](url) -> alt (run before links so the leading ! is consumed).
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	// Links [label](url) -> label.
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	// Asterisk emphasis (**bold**, *italic*, ***both***) -> inner text.
	text = text.replace(/(\*\*\*|\*\*|\*)(.+?)\1/g, "$2");
	// Underscore emphasis (__bold__, _italic_) -> inner text, but ONLY at
	// word boundaries. CommonMark forbids intraword underscores as emphasis,
	// so identifiers like AI_UPDATE_SIDEBAR / snake_case must be preserved
	// intact. The capture is `.*?` (single line, matching the asterisk rule
	// above) rather than `[\s\S]*?`: line-spanning matching would rescan to
	// end-of-string for every unclosed `_`, which is quadratic on large
	// bodies full of stray underscores (`summary` is unbounded @db.Text).
	text = text.replace(/(?<![\w])(___|__|_)(?=\S)(.*?\S)\1(?![\w])/g, "$2");
	// Strikethrough ~~text~~ -> text.
	text = text.replace(/~~(.*?)~~/g, "$1");

	// Line-level markers.
	text = text
		.split("\n")
		.map((line) =>
			line
				// Leading ATX heading markers (##, ###, …).
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				// Leading blockquote markers (possibly nested).
				.replace(/^\s{0,3}(?:>\s?)+/, "")
				// Leading unordered list markers (-, *, +).
				.replace(/^\s*[-*+]\s+/, "")
				// Leading ordered list markers (1. , 2) ).
				.replace(/^\s*\d+[.)]\s+/, "")
				// Table pipe borders -> spaces between cells.
				.replace(/\s*\|\s*/g, " ")
				.trim(),
		)
		// Drop table separator rows (---|---).
		.filter((line) => !/^[-:\s]+$/.test(line) || line.length === 0)
		.join("\n");

	// Collapse leftover paired `**` from unbalanced bold syntax. A stray lone
	// `*` is intentionally left as-is (rare, and indistinguishable from literal
	// prose); underscores are also left alone so snake_case / __dunder__ survive.
	text = text.replace(/\*\*/g, "");

	// Collapse whitespace runs (including newlines) to single spaces.
	return text.replace(/\s+/g, " ").trim();
}
