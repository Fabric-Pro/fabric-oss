/**
 * Per-PM-tool maximum title/summary length, in characters.
 *
 * Some trackers reject an over-long title by failing the *entire* create/update
 * rather than truncating it themselves. Fizzy's card title is a Rails `string`
 * column (Postgres `varchar(255)`) with no length validation, so a title of 256+
 * characters triggers an unhandled "value too long" error and the API returns an
 * opaque `HTTP 500 Internal Server Error` instead of a clean 4xx. That permanently
 * strands the item as FAILED with a misleading error.
 *
 * We clamp the *outbound* title to the destination tool's limit before pushing.
 * Fabric keeps the full title locally (and the PM card carries a "View in Fabric"
 * back-link), so nothing is lost on our side.
 *
 * Empirically verified against the live Fizzy API: a 255-char title creates
 * successfully (HTTP 201); a 256-char title returns HTTP 500.
 */
export const PM_TITLE_LIMITS: Record<string, number> = {
	fizzy: 255,
};

/** Single-code-point ellipsis appended to a truncated title to signal the cut. */
const ELLIPSIS = "…";

/**
 * Clamp `title` to the destination PM tool's limit, if one is known.
 *
 * - Returns the title unchanged when the tool has no configured limit or the
 *   title already fits.
 * - Counts and slices by Unicode code points (not UTF-16 units) so multi-byte
 *   characters are never split and the result fits Postgres' character-based
 *   `varchar(n)` budget.
 * - Reserves one code point for an appended ellipsis and trims trailing
 *   whitespace so the result reads cleanly (e.g. "…", not " …").
 *
 * IMPORTANT: callers should treat the returned string as the canonical pushed
 * title — feed it to BOTH the outbound create/update args AND any baseline hash
 * (`stampPmSyncSuccess` / `computePmHash`). Hashing the full local title while
 * pushing the truncated one would make every subsequent poll see phantom drift.
 */
export function truncateTitleForProvider(
	title: string,
	detectedType?: string | null,
): string {
	const limit = PM_TITLE_LIMITS[(detectedType ?? "").toLowerCase()];
	if (!limit) {
		return title;
	}
	const codePoints = Array.from(title);
	if (codePoints.length <= limit) {
		return title;
	}
	const head = codePoints
		.slice(0, limit - 1)
		.join("")
		.replace(/\s+$/u, "");
	return `${head}${ELLIPSIS}`;
}
