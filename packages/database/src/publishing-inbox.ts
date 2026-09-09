/**
 * Inbox section composition for Publishing Suite 1D (Fizzy #2265).
 *
 * Pure and synchronous, over the array `listPublishingTopics` already returns.
 * There is deliberately no database query behind this: the rows are all in
 * memory already, a project holds tens of topics, and a WHERE/LIMIT would buy
 * an index and a round trip to save nothing.
 */

/** The minimum shape the partition needs. Structural on purpose, so this module
 *  does not depend on the full list-item type and its test needs no fixtures. */
export interface InboxTopicShape {
	status: string;
	isSnoozed: boolean;
	updatedAt: Date;
	/**
	 * Why the model ranked this topic above its neighbours, or `null`.
	 *
	 * Optional so the flag-off row and every existing caller keep working
	 * untouched — a topic with no highlight and a caller that does not supply
	 * one are the same thing to everything below.
	 */
	highlightReason?: string | null;
	createdAt?: Date;
	/**
	 * The snooze deadline, past or future. Typed `Date` and not `Date | string`
	 * on purpose: it crosses the wire as a string like `updatedAt` does, and a
	 * string reaching `getTime()` here yields `NaN`, which compares false
	 * against every threshold — so a missed normalization would not throw, it
	 * would silently report every topic as fresh and leave the archive dead
	 * with the whole suite green. The caller normalizes both fields together.
	 */
	snoozedUntil: Date | null;
}

const RECENTLY_MODIFIED_STATUSES = new Set(["IN_PROGRESS", "SELECTED"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an untouched suggestion may sit before it reads as stale.
 *
 * A FIRST GUESS, to be tuned once there is usage data — nobody has measured
 * how long a suggestion normally waits before someone acts on it. It is a
 * named constant precisely so that tuning it is a one-line change with no
 * hunt for a literal.
 */
export const STALE_AFTER_DAYS = 30;

/**
 * How long an untouched suggestion may sit before it starts to recede.
 *
 * The EARLIER of the two thresholds, and the gentler one: a topic past it is
 * de-emphasised where it stands, never moved (see `composeInboxSections`). A
 * FIRST GUESS on exactly the same terms as `STALE_AFTER_DAYS` above — nobody
 * has measured this either, and it is a named constant so tuning it is a
 * one-line change.
 */
export const AGING_AFTER_DAYS = 10;

/**
 * How long a highlight lasts.
 *
 * Freshness is computed rather than stored, so a highlight expires on its own
 * instead of needing a sweep to clear it — and "worth a look" stops being true
 * about a topic that has sat there for a fortnight whatever the model thought
 * when it wrote it. Shorter than `AGING_AFTER_DAYS` on purpose: a topic must
 * never be able to be highlighted and quiet at the same time.
 */
export const HIGHLIGHT_LASTS_DAYS = 7;

/**
 * How long a suggestion has gone untouched, once that is worth saying.
 *
 * `days` is the whole-day count; `level` is which threshold it has passed.
 * The two travel together because the row's badge and this module's ordering
 * must never disagree about the same topic — a row labelled stale but left
 * un-sunk is the bug this shape exists to prevent.
 */
export interface TopicNeglect {
	days: number;
	level: "aging" | "stale";
}

/**
 * When a topic was last ACTIVE — and a snooze ending counts as activity.
 *
 * The later of `updatedAt` and `snoozedUntil`, and the single property the
 * whole archive rests on. FR8/UC5 require that no topic is ever lost to a
 * snooze: "it always returns on schedule". The longest preset is three months,
 * so a topic coming back is routinely older than the archive threshold
 * measured any other way, and an archive keyed on `updatedAt` would sweep away
 * exactly the topics that requirement exists to bring back.
 *
 * Defining activity this way makes the exemption a CONSEQUENCE of the
 * definition rather than a guard standing beside it. There is deliberately no
 * `if (isSnoozed) return null` anywhere below for a later reader to delete as
 * redundant: a snoozed topic's deadline is in the future, so its age here is
 * NEGATIVE and it clears no threshold; and a returning topic's clock restarts
 * at the instant its snooze elapsed, so it comes back visible however old its
 * last real edit is. Break this function and both halves of FR8 fail together
 * and loudly, which is the point.
 */
function topicLastActivityAt(topic: InboxTopicShape): Date {
	if (topic.snoozedUntil === null) {
		return topic.updatedAt;
	}
	return topic.snoozedUntil > topic.updatedAt
		? topic.snoozedUntil
		: topic.updatedAt;
}

/**
 * How neglected a topic is, or `null` if it is not neglected at all.
 *
 * Neglect requires both: it is a suggestion nobody has acted on (the status is
 * still `SUGGESTION`), and it has gone without activity for at least
 * `AGING_AFTER_DAYS`. Past `STALE_AFTER_DAYS` the level escalates to `stale`.
 * Both boundaries are INCLUSIVE — a topic untouched for exactly a threshold
 * has passed it — so the badge changes on the day it is due rather than a day
 * later.
 *
 * "Without activity" is `topicLastActivityAt` above, which is what keeps a
 * snoozed topic out of every tier without a snooze check living here.
 *
 * Pure, and `now` is a parameter, for the same reason `isTopicSnoozed` below
 * takes one: the boundaries are only testable if the caller owns the clock.
 */
export function topicNeglect(
	topic: InboxTopicShape,
	now: Date,
): TopicNeglect | null {
	if (topic.status !== "SUGGESTION") {
		return null;
	}
	const days = Math.floor(
		(now.getTime() - topicLastActivityAt(topic).getTime()) / DAY_MS,
	);
	if (days >= STALE_AFTER_DAYS) {
		return { days, level: "stale" };
	}
	return days >= AGING_AFTER_DAYS ? { days, level: "aging" } : null;
}

/**
 * Is this topic archived out of the Inbox's Suggested section?
 *
 * De-cluttering, NOT deletion: archiving is derived on every render and writes
 * nothing. The topic's status is untouched, it stays reachable through the
 * Archived filter chip and through search, and any action on it moves
 * `updatedAt` and brings it straight back — there is no state here for a
 * reader to be unable to undo.
 *
 * Exported so the section composition and the Archived chip cannot drift into
 * two different answers to the same question.
 */
export function isTopicArchived(topic: InboxTopicShape, now: Date): boolean {
	return topicNeglect(topic, now)?.level === "stale";
}

/**
 * Is this topic worth a look right now?
 *
 * Two conditions, and the second is why the first is safe to trust. The model
 * ranked it above its neighbours when the batch was written — a FORCED ranking
 * capped at two per cycle, because absolute thresholds were measured against
 * 202 staging topics and marked 68% of them. And it is still recent: a
 * highlight is a claim about what to read next, which stops being true once a
 * topic has been sitting there for a week.
 *
 * Exported so the section composition and any badge cannot drift into two
 * different answers about the same row.
 */
export function isTopicHighlighted(topic: InboxTopicShape, now: Date): boolean {
	if (!topic.highlightReason || topic.status !== "SUGGESTION") {
		return false;
	}
	const createdAt = topic.createdAt ?? topic.updatedAt;
	const days = (now.getTime() - createdAt.getTime()) / DAY_MS;
	return days < HIGHLIGHT_LASTS_DAYS;
}

/**
 * How a reader has asked for the Suggested section to be ordered.
 *
 * `recommended` is the incoming order — 1B's per-viewer ranking, computed
 * server-side — and is the DEFAULT, because it already floats a reader's own
 * beat to the top. The other two are a deliberate override, for the case the
 * card owner described: wanting the newest thing first regardless of whose beat
 * it is.
 */
export type InboxSort = "recommended" | "recentlyUpdated" | "recentlyCreated";

export function composeInboxSections<T extends InboxTopicShape>(
	items: readonly T[],
	opts: { maxRecent?: number; now?: Date; sort?: InboxSort } = {},
): {
	recentlyModified: T[];
	recentlyModifiedTotal: number;
	/** Highlighted AND still fresh — see `isTopicHighlighted`. */
	worthALook: T[];
	suggested: T[];
	archived: T[];
} {
	const maxRecent = opts.maxRecent ?? 3;
	const now = opts.now ?? new Date();
	const sort = opts.sort ?? "recommended";
	const live = items.filter((t) => !t.isSnoozed);

	// FR2 names `updatedAt`, which is NOT the key the array arrives sorted by,
	// and the section is capped — so this one genuinely must sort. A cap taken
	// over an array ordered by something else would pick the wrong three.
	const recent = live
		.filter((t) => RECENTLY_MODIFIED_STATUSES.has(t.status))
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

	// Suggested FILTERS and still does not SORT. The incoming array is already
	// in 1B's per-viewer tier order (contributed, then role-match, then the
	// rest) with createdAt desc inside each tier. Re-sorting globally by
	// createdAt would flatten those tiers and switch personalization off in
	// what is becoming the default view — a change to 1B, which 1D puts out of
	// scope.
	//
	// What it now does is PARTITION, in one further pass: everything the
	// section keeps, and everything the archive takes out of it. A stable
	// partition is the whole point: `push` visits the array in order and never
	// reorders within a group, so 1B's tier order survives intact inside
	// `suggested` AND inside `archived`. A comparator keyed on staleness would
	// land the same result today — `sort` is stable — but it is the SHAPE that
	// invites the next reader to add a date tiebreak while they are in there,
	// and that is precisely the 1B regression the paragraph above exists to
	// prevent.
	//
	// THREE groups now, not two — the card owner asked for the aging band to
	// sink rather than only recede in place, and this is that change.
	//
	// The paragraph this replaces argued that a third group is a sort by
	// neglect, and that a sort is the one thing this section may not do to 1B's
	// tier order. Half of that still holds, which is why the partition is
	// shaped the way it is:
	//
	//  - `active` — everything under `AGING_AFTER_DAYS` — is built by a STABLE
	//    partition and never sorted, so 1B's per-viewer tier order survives
	//    byte-for-byte at the HEAD of the section, where personalization is
	//    the thing that matters. #2265's ranking is untouched for every topic
	//    a reader is realistically going to act on.
	//  - `aging` is the de-prioritised tail, and there the owner's rule wins:
	//    the longer a topic has been quiet the further down it goes. Ordering
	//    by neglect inside a group that is already sinking costs nothing that
	//    tiering was protecting — a topic nobody has touched in three weeks is
	//    not being ranked for relevance any more, it is being queued for
	//    archival.
	//  - `archived` leaves the section entirely at `STALE_AFTER_DAYS`.
	//
	// `days` ascending, so the least neglected sits closest to the live topics
	// and the oldest is last in the list before it disappears. Ties keep tier
	// order, because `sort` is stable and the input already carries it.
	const worthALook: T[] = [];
	const active: T[] = [];
	const aging: T[] = [];
	const archived: T[] = [];
	for (const t of live) {
		if (t.status !== "SUGGESTION") {
			continue;
		}
		const neglect = topicNeglect(t, now);
		if (neglect !== null) {
			(neglect.level === "stale" ? archived : aging).push(t);
			continue;
		}
		// A highlight the model wrote, and only while it is still fresh. The
		// count cap was applied when the batch was written, so a cycle can put
		// at most two topics here; the age test is what stops them accumulating
		// across cycles into a third permanent section.
		(isTopicHighlighted(t, now) ? worthALook : active).push(t);
	}
	aging.sort(
		(a, b) =>
			(topicNeglect(a, now)?.days ?? 0) -
			(topicNeglect(b, now)?.days ?? 0),
	);
	/**
	 * The reader's sort applies to the LIVE head and to nothing else.
	 *
	 * `aging` is already ordered by neglect, and that ordering IS the sink —
	 * re-sorting the tail by date would undo the very thing the control sits
	 * above. `archived` never renders in order at all. And `recommended` sorts
	 * nothing, because the incoming order is the answer: re-sorting it by any
	 * date flattens the per-viewer tiers that order carries, which is exactly
	 * what defaulting to a date sort would have done to everyone who never
	 * opens the control.
	 */
	if (sort === "recentlyUpdated") {
		active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
	} else if (sort === "recentlyCreated") {
		active.sort(
			(a, b) =>
				(b.createdAt ?? b.updatedAt).getTime() -
				(a.createdAt ?? a.updatedAt).getTime(),
		);
	}

	const suggested = [...active, ...aging];

	return {
		recentlyModified: recent.slice(0, maxRecent),
		recentlyModifiedTotal: recent.length,
		worthALook,
		suggested,
		archived,
	};
}

/**
 * Is a topic still snoozed at `now`? (1D, Fizzy #2265)
 *
 * The boundary is deliberately EXCLUSIVE: a snooze whose deadline has exactly
 * arrived counts as ELAPSED, so the topic re-surfaces on the instant it is due
 * rather than one tick later. Pure, and `now` is a parameter, because this is
 * the only way the boundary itself can be tested — a database test cannot
 * control the clock the query reads.
 */
export function isTopicSnoozed(snoozedUntil: Date | null, now: Date): boolean {
	return snoozedUntil !== null && snoozedUntil > now;
}
