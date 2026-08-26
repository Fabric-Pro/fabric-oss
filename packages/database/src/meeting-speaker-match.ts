// Pure, DB-free helpers for transcript-speaker -> project-member attribution
// (Publishing Suite 1B tail). Display-only heuristic name match; see
// docs/superpowers/specs/2026-07-24-publishing-suite-transcript-speaker-attribution-design.md
//
// The user-facing label is "Meeting participants"; this module keeps the
// "speakers" name because it operates on ProjectMeetingTranscript.speakerNames.

/** Max matched members shown on the card line before "+N more". */
export const MEETING_PARTICIPANTS_CAP = 3;

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
 */
export function buildMeetingSpeakers(
	matched: { id: string; name: string | null; username: string | null }[],
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
		members: ordered.slice(0, MEETING_PARTICIPANTS_CAP),
		overflowCount: Math.max(0, ordered.length - MEETING_PARTICIPANTS_CAP),
	};
}
