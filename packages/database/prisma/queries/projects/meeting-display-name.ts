/**
 * What to call a meeting that already happened (Fizzy #2340).
 *
 * Two columns can name it, and they are not interchangeable.
 * `ProjectLinkedMeeting.subject` names the recurring SERIES — its `joinUrl` is
 * "stable across recurring instances" by the schema's own comment — and it is
 * captured when someone links the meeting, refreshed only if they link it
 * again. `ProjectMeetingTranscript.meetingSubject` names the OCCURRENCE, and is
 * resolved at that occurrence's first successful sync.
 *
 * Both are snapshots. The occurrence one is simply taken later, and taken per
 * occurrence, which is why it survives a series rename and the other does not.
 * Rename a Teams series and every past occurrence starts answering to a title
 * it never had — the defect this module exists to end.
 *
 * This reverses a precedence that was deliberate and written down: the series
 * subject was preferred as "the more stable label". That reasoning was half
 * right. The series name does not vary per occurrence, but it is stable the way
 * a photograph is stable, and a label that is reliably wrong is worse than one
 * that varies because the meetings varied.
 *
 * Lives in @repo/database for the reason `meeting-action-item-keys.ts` does:
 * @repo/api and @repo/temporal both need it and neither depends on the other.
 * Pure, no DB and no imports, so the rule is trivially testable in isolation —
 * which matters because the to-do list cannot call it. That query is raw SQL
 * and mirrors this function in a COALESCE; the two are kept honest by tests on
 * both sides rather than by a shared call.
 */

/**
 * An occurrence subject that carries no information, and must therefore lose to
 * the series name.
 *
 * Not a defensive nicety — without it this whole change is a regression. The
 * write path looks like a three-way fallback
 * (`meeting.subject || linkedMeeting.subject || "Untitled Meeting"`) but is not:
 * `MeetingInstance.subject` is non-optional, and every Graph path that produces
 * it has already applied `|| "Untitled Meeting"` upstream. So the middle branch
 * is unreachable, and a calendar event with no subject of its own is stored as
 * this literal string rather than as the series name.
 *
 * A resolver keyed on `null` alone would therefore hand that placeholder a win
 * over a real series name, which is precisely the blank-or-placeholder outcome
 * this feature promised not to produce.
 */
export const PLACEHOLDER_SUBJECT = "Untitled Meeting";

/**
 * The subject if it actually names something, else `null`.
 *
 * Deliberately NOT a `subject is string` type predicate. Failing this check does
 * not mean "not a string" — the placeholder is a perfectly good string that
 * simply names nothing — and a predicate saying otherwise narrows the failing
 * branch to `null | undefined`, which makes the last resort below unreachable.
 *
 * Blankness is `trim()`, not `isEffectivelyBlank` from @repo/utils, which also
 * catches zero-width and other invisible format characters. That helper is the
 * better test in isolation — but the to-do list mirrors this rule in raw SQL,
 * and the two must agree or one meeting gets two names.
 *
 * The mirror therefore spells its characters out. One-argument Postgres `BTRIM`
 * strips U+0020 ONLY — a tab, a newline or an ideographic space all survive it
 * — so it is handed the explicit set that ECMAScript `trim()` removes, right
 * down to U+3000 and U+205F. Both sides then also agree on what they DO NOT
 * strip: U+200B and friends survive here and in SQL alike, which is why
 * adopting `isEffectivelyBlank` would have to change the SQL in the same
 * commit. Tighten both together or neither.
 *
 * That agreement is measured, not asserted. The parity block in
 * `packages/database/__tests__/todo-list-query.test.ts` runs every pair drawn
 * from a shared input set through this function and through a live `SELECT` of
 * the SQL expression, and fails naming the inputs that disagree. It is how the
 * U+3000 and U+2028 gap in an earlier, shorter character set was found.
 */
function usableName(subject: string | null | undefined): string | null {
	const trimmed = subject?.trim();
	if (!trimmed || trimmed === PLACEHOLDER_SUBJECT) {
		return null;
	}
	return trimmed;
}

/**
 * The name to show for a meeting that has been transcribed.
 *
 * Returns `null` when neither column names anything, matching what already
 * flows: two call sites normalize with a trailing `?? null` today, and the
 * digest procedure declares no output schema, so `string | null` is the shape
 * its consumers already receive.
 *
 * Do NOT use this for a meeting that has not happened yet. An upcoming
 * occurrence has no transcript and therefore no occurrence subject, so the
 * series name is both the only name in hand and the correct one — see
 * `generate-agenda.ts`, which is deliberately left alone.
 *
 * Takes a named object rather than two positional strings on purpose. Both
 * inputs are `string | null | undefined`, so a positional signature lets any
 * call site swap them and typecheck cleanly — and swapping them is not a typo,
 * it IS the bug this module was written to fix. Named, an inversion stops
 * compiling at every one of the five call sites at once, which is coverage no
 * amount of per-site testing buys.
 */
export function resolveMeetingDisplayName({
	occurrence: occurrenceSubject,
	series: seriesSubject,
}: {
	/** `ProjectMeetingTranscript.meetingSubject` — this occurrence's own name. */
	occurrence: string | null | undefined;
	/** `ProjectLinkedMeeting.subject` — the recurring series' current name. */
	series: string | null | undefined;
}): string | null {
	const occurrence = usableName(occurrenceSubject);
	if (occurrence) {
		return occurrence;
	}
	const series = usableName(seriesSubject);
	if (series) {
		return series;
	}
	// Neither names anything. Prefer a stored placeholder over inventing one, so
	// a caller that wants to render "Untitled Meeting" still can and a caller
	// that wants to hide the label still sees an absence it can test for.
	return occurrenceSubject?.trim() || seriesSubject?.trim() || null;
}
