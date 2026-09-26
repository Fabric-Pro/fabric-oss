/**
 * Normalize a user-typed roadmap search query by stripping legacy ticket
 * prefixes (`F-`, `B-`, `US-`, `TASK-`, case-insensitive) so search input
 * matches both legacy prefixed identifiers AND new plain-decimal identifiers
 * (spec 2026-05-21 §7.4 / §A6).
 *
 * The regex is anchored at the start (`^`) so substrings inside non-identifier
 * text are untouched — e.g. `"feature-something"` stays `"feature-something"`.
 *
 * The function is pure and idempotent and intentionally lives in its OWN file
 * (no DB imports) so client-side bundlers don't drag the entire Prisma client
 * graph (pg, dns, @prisma/adapter-pg, …) into the browser when client code
 * imports it.
 */
export function normalizeStoryIdentifierQuery(input: string): string {
	return input.replace(/^(F-|B-|US-|TASK-)/i, "");
}

// No separate `0*` before the digits: it and `\d+` both match `0`, so a long
// run of zeros followed by a non-digit was retried at every split
// (CodeQL js/polynomial-redos). `Number()` already ignores leading zeros.
const IDENTIFIER_NUMBER = /^(?:([A-Z]+)-)?(\d+)$/i;

/**
 * Numeric-aware order for story identifiers, which mix legacy prefixed values
 * (`F-094`, `B-002`) with new plain decimals (`100`). Sorting the column as
 * text puts `F-100` before `F-094` and `100` before `99`; this compares the
 * number first, then the prefix, and puts identifiers with no number last.
 */
export function compareStoryIdentifiers(a: string, b: string): number {
	const ma = a.match(IDENTIFIER_NUMBER);
	const mb = b.match(IDENTIFIER_NUMBER);
	if (ma && mb) {
		const byNumber = Number(ma[2]) - Number(mb[2]);
		if (byNumber !== 0) {
			return byNumber;
		}
		const pa = (ma[1] ?? "").toUpperCase();
		const pb = (mb[1] ?? "").toUpperCase();
		if (pa !== pb) {
			return pa < pb ? -1 : 1;
		}
	} else if (ma || mb) {
		return ma ? -1 : 1;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}
