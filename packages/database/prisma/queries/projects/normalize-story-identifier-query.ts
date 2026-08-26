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
