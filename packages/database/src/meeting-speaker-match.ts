// Pure, DB-free helpers for transcript-speaker -> project-member attribution
// (Publishing Suite 1B tail). Display-only heuristic name match; see
// docs/superpowers/specs/2026-07-24-publishing-suite-transcript-speaker-attribution-design.md
//
// The user-facing label is "Meeting participants"; this module keeps the
// "speakers" name because it operates on ProjectMeetingTranscript.speakerNames.

/** Max matched members shown on the card line before "+N more". */
export const MEETING_PARTICIPANTS_CAP = 3;

/**
 * Max matched members carried by the SINGLE-topic read (`getPublishingTopic`).
 *
 * The Inbox line has room for three names and the list serves 133 rows, so it
 * keeps the tight cap — the names beyond it are not in the payload and the
 * "+N more" there is a fact about the meeting, not a hidden list. The topic
 * page shows ONE topic and is where a reader goes to ask "who was in that
 * meeting", so it pays for the rest and lets them unfold it.
 *
 * Still capped rather than unbounded: matches are bounded by the project
 * roster, and a ceiling keeps one enormous project from turning a page read
 * into a large hydration. A payload that hits it still reports the remainder
 * through `overflowCount`, so the line stays honest instead of silently
 * truncating.
 */
export const MEETING_PARTICIPANTS_DETAIL_CAP = 25;

/** Wire shape attached to each list item. null = degraded OR no confident match. */
export type MeetingSpeakers = {
	members: { id: string; name: string | null; username: string | null }[];
	overflowCount: number;
} | null;

/** lowercase -> trim -> collapse inner whitespace runs to a single space. */
export function normalizeName(s: string): string {
	return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Build a normalized-name -> set of DISTINCT member userIds index from a
 * getProjectMembers() roster. Distinctness matters: getProjectMembers can emit
 * the same user twice (synthesized owner + accepted self-invite), and a lone
 * member across two rows must collapse to one id, NOT read as ambiguous.
 * Members with a blank/"unknown" normalized name are never indexed.
 */
export function buildRosterIndex(
	members: { userId: string; user: { name: string | null } }[],
): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	for (const m of members) {
		const n = normalizeName(m.user?.name ?? "");
		if (n === "" || n === "unknown") {
			continue;
		}
		let set = index.get(n);
		if (!set) {
			set = new Set<string>();
			index.set(n, set);
		}
		set.add(m.userId);
	}
	return index;
}

/**
 * Match a raw free-text speaker name to a single member userId, or null.
 * Fail-closed: blank/"unknown" -> null; a name held by >=2 DISTINCT members -> null.
 */
export function matchSpeaker(
	rawSpeaker: string,
	roster: Map<string, Set<string>>,
): string | null {
	const n = normalizeName(rawSpeaker);
	if (n === "" || n === "unknown") {
		return null;
	}
	const ids = roster.get(n);
	if (!ids || ids.size !== 1) {
		return null;
	}
	return [...ids][0];
}

/**
 * Given the matched members for a topic (already deduped by id via a Set),
 * produce the capped, deterministically-ordered wire value. Order: normalized
 * display name asc, then id asc (total order). Empty -> null.
 *
 * `cap` defaults to the Inbox's `MEETING_PARTICIPANTS_CAP`, so every existing
 * caller keeps the shape it already returns. The single-topic read raises it
 * (`MEETING_PARTICIPANTS_DETAIL_CAP`) so the topic page can unfold the rest.
 * The ORDER is what makes that safe: the first `cap` entries are the same
 * entries whichever cap is in force, so the names a reader sees collapsed on
 * the topic page are exactly the ones the Inbox row showed them.
 */
export function buildMeetingSpeakers(
	matched: { id: string; name: string | null; username: string | null }[],
	cap: number = MEETING_PARTICIPANTS_CAP,
): MeetingSpeakers {
	if (matched.length === 0) {
		return null;
	}
	const ordered = [...matched].sort((a, b) => {
		const an = normalizeName(a.name ?? "");
		const bn = normalizeName(b.name ?? "");
		if (an < bn) {
			return -1;
		}
		if (an > bn) {
			return 1;
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return {
		members: ordered.slice(0, cap),
		overflowCount: Math.max(0, ordered.length - cap),
	};
}
