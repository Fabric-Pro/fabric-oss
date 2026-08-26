/**
 * Text Normalizer for AI Responses
 *
 * Converts common Unicode formatting patterns (often used by reasoning models like o1)
 * into standard markdown syntax for proper rendering.
 *
 * Common patterns from reasoning models:
 * - Unicode bullets (•, ‣, ◦, ▪, ▸) → Markdown list items (-)
 * - Decorative header lines (──── TITLE ────) → Markdown headers (#)
 * - Unicode arrows/symbols → Plain text or markdown equivalents
 * - Smart quotes → Standard quotes
 */

/**
 * Normalizes Unicode bullets to markdown list syntax.
 *
 * Converts various Unicode bullet characters at the start of lines
 * to standard markdown list syntax (-).
 */
function normalizeBullets(text: string): string {
	// Unicode bullet patterns commonly used by AI models
	// Must be at start of line (after optional whitespace)
	const bulletPatterns = [
		/^(\s*)•\s*/gm, // Bullet point
		/^(\s*)‣\s*/gm, // Triangular bullet
		/^(\s*)◦\s*/gm, // White bullet
		/^(\s*)▪\s*/gm, // Black small square
		/^(\s*)▸\s*/gm, // Black right-pointing small triangle
		/^(\s*)►\s*/gm, // Black right-pointing pointer
		/^(\s*)○\s*/gm, // White circle
		/^(\s*)●\s*/gm, // Black circle
		/^(\s*)◆\s*/gm, // Black diamond
		/^(\s*)◇\s*/gm, // White diamond
		/^(\s*)➤\s*/gm, // Heavy right-pointing angle quotation mark ornament
		/^(\s*)→\s*/gm, // Rightwards arrow (when used as bullet)
		/^(\s*)✓\s*/gm, // Check mark (convert to task list)
		/^(\s*)✗\s*/gm, // Ballot X (convert to unchecked task)
		/^(\s*)☐\s*/gm, // Ballot box (unchecked)
		/^(\s*)☑\s*/gm, // Ballot box with check
		/^(\s*)☒\s*/gm, // Ballot box with X
	];

	let result = text;

	// Handle task list items specially
	result = result.replace(/^(\s*)✓\s*/gm, "$1- [x] ");
	result = result.replace(/^(\s*)☑\s*/gm, "$1- [x] ");
	result = result.replace(/^(\s*)✗\s*/gm, "$1- [ ] ");
	result = result.replace(/^(\s*)☐\s*/gm, "$1- [ ] ");
	result = result.replace(/^(\s*)☒\s*/gm, "$1- [ ] ");

	// Replace other bullets with standard markdown list items
	for (const pattern of bulletPatterns.slice(0, 12)) {
		result = result.replace(pattern, "$1- ");
	}

	return result;
}

/**
 * Normalizes decorative header lines to markdown headers.
 *
 * Patterns like:
 * - "──────── WEEK 1: TITLE ────────"
 * - "═══════ SECTION ═══════"
 * - "******* HEADING *******"
 * - "------- Title -------"
 *
 * Become: "## WEEK 1: TITLE" or "## SECTION"
 */
function normalizeDecorativeHeaders(text: string): string {
	// Pattern: Lines that are mostly decorative characters with text in the middle
	// Match: start, optional space, 3+ decorative chars, space, text, space, 3+ decorative chars, end
	const decorativePatterns = [
		// Box-drawing characters (─, ═, ━)
		/^[\s]*[─═━]{3,}[\s]*(.+?)[\s]*[─═━]{3,}[\s]*$/gm,
		// Asterisks
		/^[\s]*\*{3,}[\s]*(.+?)[\s]*\*{3,}[\s]*$/gm,
		// Dashes
		/^[\s]*-{3,}[\s]*(.+?)[\s]*-{3,}[\s]*$/gm,
		// Underscores
		/^[\s]*_{3,}[\s]*(.+?)[\s]*_{3,}[\s]*$/gm,
		// Equal signs
		/^[\s]*={3,}[\s]*(.+?)[\s]*={3,}[\s]*$/gm,
	];

	let result = text;

	for (const pattern of decorativePatterns) {
		result = result.replace(pattern, "## $1");
	}

	// Also handle standalone decorative lines (just remove them or convert to hr)
	// Lines that are ONLY decorative characters (no meaningful text)
	result = result.replace(/^[\s]*[─═━]{5,}[\s]*$/gm, "---");
	result = result.replace(/^[\s]*\*{5,}[\s]*$/gm, "---");
	result = result.replace(/^[\s]*-{5,}[\s]*$/gm, "---");
	result = result.replace(/^[\s]*_{5,}[\s]*$/gm, "---");
	result = result.replace(/^[\s]*={5,}[\s]*$/gm, "---");

	return result;
}

/**
 * Normalizes numbered lists that use non-standard patterns.
 *
 * Patterns like:
 * - "1) Item" → "1. Item"
 * - "(1) Item" → "1. Item"
 * - "1- Item" → "1. Item"
 */
function normalizeNumberedLists(text: string): string {
	// Pattern: number followed by ) or - instead of .
	const patterns = [
		/^(\s*)(\d+)\)\s+/gm, // "1) " → "1. "
		/^(\s*)\((\d+)\)\s+/gm, // "(1) " → "1. "
		/^(\s*)(\d+)-\s+/gm, // "1- " → "1. "
	];

	let result = text;

	result = result.replace(patterns[0], "$1$2. ");
	result = result.replace(patterns[1], "$1$2. ");
	result = result.replace(patterns[2], "$1$2. ");

	return result;
}

/**
 * Normalizes smart quotes and other typography to ASCII equivalents.
 */
function normalizeQuotes(text: string): string {
	return (
		text
			// Smart double quotes
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Smart single quotes
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// En/Em dashes in certain contexts (leave most alone but normalize some)
			.replace(/\s—\s/g, " - ") // Em dash with spaces → hyphen with spaces
	);
}

/**
 * Normalizes emphasis markers from Unicode to markdown.
 *
 * Some models use Unicode mathematical bold/italic characters.
 */
function normalizeEmphasis(text: string): string {
	// This is complex because Unicode math italic/bold use different code points
	// For now, just handle the most common cases where models use special Unicode
	// characters for emphasis

	// Mathematical bold A-Z (U+1D400-U+1D419) and a-z (U+1D41A-U+1D433)
	// This is rare but some models do use it
	// For simplicity, we'll skip this transformation as it's uncommon

	return text;
}

/**
 * Main normalization function.
 *
 * Applies all text normalizations to convert Unicode formatting
 * to standard markdown syntax.
 */
export function normalizeTextToMarkdown(text: string): string {
	if (!text) {
		return text;
	}

	let result = text;

	// Apply normalizations in order
	result = normalizeBullets(result);
	result = normalizeDecorativeHeaders(result);
	result = normalizeNumberedLists(result);
	result = normalizeQuotes(result);
	result = normalizeEmphasis(result);

	return result;
}
