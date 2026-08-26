/**
 * Recognise Graph refusing to resolve a meeting for this caller (#1899, DEF-6).
 *
 * `get_meeting_by_join_url` queries `/me/onlineMeetings`, which Graph answers
 * only for meetings the signed-in user can resolve. For one organised by a
 * colleague it returns 403 with `3003: User does not have access to lookup
 * meeting`. That is an ordinary outcome of browsing your own calendar, not a
 * fault — but it fell through to the generic 500 path, so the sheet showed a
 * bare "Failed to load transcript".
 *
 * The path only became reachable in practice once #2226 began rendering
 * linked-but-unsynced meetings, which made those rows clickable.
 *
 * Matched on the numeric `3003` code rather than the prose: Graph's wording is
 * not contractual, the code is. Deliberately narrow — a 403 about
 * `OnlineMeetingTranscript.Read.All` is a DIFFERENT condition with its own
 * admin-consent affordance, and must not be relabelled "you don't have access
 * to this meeting".
 */
export function isMeetingLookupForbiddenError(message: string): boolean {
	return message.includes("403") && message.includes("3003");
}

/**
 * Recognise Graph being unable to resolve a meeting for this join URL at all
 * (#2170, found by QA).
 *
 * The sibling of the 3003 case above, and on a real calendar the far larger
 * one: measured on staging 2026-08-19, 19 of 22 personal meetings answered
 * 404 with `3004: Specified meeting is not found`. Graph does not commit to a
 * single shape for "I cannot resolve this" — it also returns 200 with an empty
 * `value` array, which the integration layer already maps to a graceful "no
 * meeting found" — so only the 404 escaped as a throw, reaching the user as an
 * HTTP 500 and an invitation to "Try again" that could never succeed.
 *
 * Deliberately NOT folded into `isMeetingLookupForbiddenError`. 3003 is "this
 * meeting belongs to someone else"; 3004 is "no such meeting is resolvable for
 * you", which is what a calendar entry with no Teams meeting behind it, or one
 * whose online-meeting record is no longer retrievable, looks like. Collapsing
 * them would tell a user their own meeting was a colleague's.
 *
 * Matched on the numeric `3004` code rather than the prose, for the same reason
 * as above: Graph's wording is not contractual, the code is. The 404 is checked
 * too so an unrelated not-found (a transcript id, say) cannot borrow this copy.
 */
export function isMeetingNotFoundError(message: string): boolean {
	return message.includes("404") && message.includes("3004");
}
