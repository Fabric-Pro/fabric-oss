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

export function composeInboxSections<T extends InboxTopicShape>(
	items: readonly T[],
	opts: { maxRecent?: number; now?: Date } = {},
): {
	recentlyModified: T[];
	recentlyModifiedTotal: number;
	suggested: T[];
	archived: T[];
} {
	const maxRecent = opts.maxRecent ?? 3;
	const now = opts.now ?? new Date();
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
	// TWO groups, not three, even though `topicNeglect` reports three states.
	// An `aging` topic is de-emphasised WHERE IT STANDS and must not move: a
	// third group is a sort by neglect, and a sort is the one thing this
	// section may not do to 1B's tier order. Only stale topics leave.
	//
	// They LEAVE rather than sink. Stale used to be pushed to the bottom of
	// this section; the archive supersedes that for the same set, because at
	// equal thresholds the two rules select the same topics — `live` has
	// already dropped every snoozed one, so there is no stale-but-unarchived
	// topic left for a sink to order. Reverting is a one-line reroute:
	// `[...suggested, ...archived]` here, and the caller's footer goes quiet
	// on its own because the array it counts is empty.
	const suggested: T[] = [];
	const archived: T[] = [];
	for (const t of live) {
		if (t.status !== "SUGGESTION") {
			continue;
		}
		(isTopicArchived(t, now) ? archived : suggested).push(t);
	}

	return {
		recentlyModified: recent.slice(0, maxRecent),
		recentlyModifiedTotal: recent.length,
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
