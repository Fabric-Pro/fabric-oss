/**
 * Anchor resolver for Meeting Digest insight items (#1896).
 *
 * Insight extraction asks the LLM for a short verbatim `sourceQuote` per
 * decision / action item / open question. These pure helpers validate the
 * quote against the stored transcript body and convert it to a stable
 * 1-based line index (`anchorLine`) that the transcript reader page can
 * scroll to. Unmatched quotes resolve to null — callers drop the anchor and
 * render plain text, so a dead link is structurally impossible.
 */

const MIN_QUOTE_LENGTH = 8;

/**
 * 1-based line index of the first occurrence of `quote` in `content`, or
 * null. Tries an exact substring match first, then a normalized match that
 * tolerates case, whitespace, and punctuation drift.
 */
export function resolveQuoteAnchor(
	content: string,
	quote: string,
): number | null {
	const needle = quote.trim();
	if (!content || needle.length < MIN_QUOTE_LENGTH) {
		return null;
	}
	let index = content.indexOf(needle);
	if (index === -1) {
		index = normalizedIndexOf(content, needle);
	}
	if (index === -1) {
		return null;
	}
	return lineOfIndex(content, index);
}

/**
 * Attach `sourceQuote`/`anchorLine` to an insight item when the quote
 * resolves against `content`. Passing `content: null` (extraction ran on the
 * summary fallback, not the transcript body) always returns the item as-is.
 */
export function attachAnchor<T extends object>(
	item: T,
	sourceQuote: string | undefined,
	content: string | null,
): T & { sourceQuote?: string; anchorLine?: number } {
	if (!sourceQuote || !content) {
		return item;
	}
	const anchorLine = resolveQuoteAnchor(content, sourceQuote);
	if (anchorLine === null) {
		return item;
	}
	return { ...item, sourceQuote: sourceQuote.trim(), anchorLine };
}

function lineOfIndex(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (content.charCodeAt(i) === 10) {
			line += 1;
		}
	}
	return line;
}

/**
 * Case/whitespace/punctuation-insensitive indexOf that maps the match back
 * to an offset in the ORIGINAL string. Letters/digits (unicode) are kept
 * lowercased; every other run of characters collapses to a single space.
 */
function normalizedIndexOf(content: string, quote: string): number {
	const norm = normalizeWithOffsets(content);
	const needle = normalizeWithOffsets(quote).normalized.trim();
	if (!needle) {
		return -1;
	}
	const at = norm.normalized.indexOf(needle);
	if (at === -1) {
		return -1;
	}
	return norm.offsets[at] ?? -1;
}

function normalizeWithOffsets(source: string): {
	normalized: string;
	offsets: number[];
} {
	// Iterate the ORIGINAL string so every recorded offset indexes back into
	// `source` (the caller maps a normalized match position to a `source`
	// index and then to a line). Lowercase per character: a char whose
	// lowercase form is longer than one code unit (e.g. İ → i̇) still maps each
	// of its normalized code units to the single original index it came from,
	// so subsequent offsets never drift.
	let normalized = "";
	const offsets: number[] = [];
	let pendingSpace = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (/[\p{L}\p{N}]/u.test(ch)) {
			if (pendingSpace && normalized.length > 0) {
				normalized += " ";
				offsets.push(i);
			}
			pendingSpace = false;
			const lower = ch.toLowerCase();
			normalized += lower;
			for (let k = 0; k < lower.length; k++) {
				offsets.push(i);
			}
		} else {
			pendingSpace = true;
		}
	}
	return { normalized, offsets };
}
