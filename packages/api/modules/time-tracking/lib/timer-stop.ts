/**
 * Turning a timer into time entries, and proposing when it stopped.
 *
 * A start/stop project gets one entry per segment, each with its own start
 * and stop. A duration-only project gets ONE entry: the summed segments as a
 * duration, with no start or stop, because an entry's start and stop must
 * span exactly its duration and the pauses between segments are not work.
 * Either way a segment under a minute is dropped, and a timer whose segments
 * are all under a minute saves nothing.
 *
 * The entries then go through the same hard rules as `createEntry`
 * (`resolveEntryTiming`) and the same warnings, checked across the new
 * entries together so their daily total counts every one of them.
 */

import { ORPCError } from "@orpc/server";
import {
	listAuthorTimeEntriesOnWorkDate,
	type TimeTimerSegmentRow,
} from "@repo/database";
import { localDateOf } from "@repo/utils/time-suggestions";
import {
	detectTimeEntryWarnings,
	type TimeEntryFacts,
	type TimeEntryWarning,
	type TimeWarningCode,
} from "@repo/utils/time-tracking";

/** A segment shorter than this is dropped when the timer stops. */
const MIN_SEGMENT_MS = 60_000;

/** Minutes since the last activity after which a stop asks when work ended. */
const ACTIVITY_GAP_QUESTION_MINUTES = 30;

/**
 * Minutes a segment may run with no activity recorded before a stop asks
 * when work ended.
 */
const NO_ACTIVITY_QUESTION_MINUTES = 4 * 60;

/**
 * How far back from a stop the member's activity counts as coming back to
 * stop the timer rather than as work: opening My time or a project writes
 * activity of its own, which would otherwise always look like the last work.
 */
export const RETURN_WINDOW_MINUTES = 15;

interface ClosedSegment {
	startAt: Date;
	stopAt: Date;
}

/**
 * The timer's segments with the open one closed at `stopAt`, or at `now`
 * when it is omitted. A given `stopAt` must lie within the open segment,
 * from its start to `now`. A paused timer has no open segment, so `stopAt`
 * does not apply to it.
 */
export function closeTimerSegments(params: {
	segments: readonly TimeTimerSegmentRow[];
	stopAt: Date | undefined;
	now: Date;
}): ClosedSegment[] {
	return params.segments.map((segment) => {
		if (segment.stopAt) {
			return { startAt: segment.startAt, stopAt: segment.stopAt };
		}
		if (params.stopAt === undefined) {
			// No earlier than the start, in case this application clock is a
			// little behind the one that opened the segment.
			return {
				startAt: segment.startAt,
				stopAt: new Date(
					Math.max(params.now.getTime(), segment.startAt.getTime()),
				),
			};
		}
		if (
			params.stopAt.getTime() < segment.startAt.getTime() ||
			params.stopAt.getTime() > params.now.getTime()
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The stop time must be between the timer's last start and now",
			});
		}
		return { startAt: segment.startAt, stopAt: params.stopAt };
	});
}

/** One entry a stopped timer saves, before the entry rules check it. */
interface PlannedTimerEntry {
	workDate: string;
	timing: { durationMinutes?: number; startAt?: string; stopAt?: string };
}

/**
 * The entries a timer with these closed segments saves. Work dates are the
 * day each entry starts in `timezone`.
 */
export function planTimerEntries(params: {
	segments: readonly ClosedSegment[];
	timezone: string;
	startStopRequired: boolean;
}): PlannedTimerEntry[] {
	const kept = params.segments.filter(
		(segment) =>
			segment.stopAt.getTime() - segment.startAt.getTime() >=
			MIN_SEGMENT_MS,
	);
	const first = kept[0];
	if (!first) {
		return [];
	}
	if (params.startStopRequired) {
		return kept.map((segment) => ({
			workDate: localDateOf(segment.startAt, params.timezone),
			timing: {
				startAt: segment.startAt.toISOString(),
				stopAt: segment.stopAt.toISOString(),
			},
		}));
	}
	const totalMs = kept.reduce(
		(sum, segment) =>
			sum + segment.stopAt.getTime() - segment.startAt.getTime(),
		0,
	);
	return [
		{
			workDate: localDateOf(first.startAt, params.timezone),
			timing: { durationMinutes: Math.round(totalMs / 60_000) },
		},
	];
}

interface TimerStopProposal {
	proposedStopAt: Date;
	/** The activity the proposal is read from, or null. */
	source: { action: string; at: Date } | null;
	/**
	 * Whole minutes without activity: from that activity (or the last start)
	 * until the member came back, or until now when they have not.
	 */
	gapMinutes: number;
	/** Whether to ask the member when they stopped working. */
	needsQuestion: boolean;
}

/**
 * When the timer most likely stopped being work.
 *
 * A paused timer stopped at its pause. A running one is measured from
 * `activity`, the member's newest activity inside the open segment from
 * before the last {@link RETURN_WINDOW_MINUTES}, or from that segment's start
 * when there is none. The quiet stretch runs from there to `returnedAt`, the
 * member's first activity within that window, or to now when there is none.
 * Within {@link ACTIVITY_GAP_QUESTION_MINUTES} (or
 * {@link NO_ACTIVITY_QUESTION_MINUTES} from a start without activity) the
 * proposal is now and nothing is asked; past it, the member is asked, and the
 * proposal is that activity, or now when there was none. Always within the
 * open segment, from its start to now.
 */
export function proposeTimerStop(params: {
	segments: readonly TimeTimerSegmentRow[];
	activity: { action: string; createdAt: Date } | null;
	returnedAt: Date | null;
	now: Date;
}): TimerStopProposal {
	const { now, activity } = params;
	const open = params.segments.find((segment) => segment.stopAt === null);
	if (!open) {
		const pausedAt = params.segments.at(-1)?.stopAt ?? now;
		return {
			proposedStopAt: pausedAt,
			source: null,
			gapMinutes: 0,
			needsQuestion: false,
		};
	}

	// Activity before the open segment started says nothing about when this
	// segment ended; measure from the later of the two instead.
	const activityInSegment =
		activity && activity.createdAt > open.startAt ? activity : null;
	const reference = activityInSegment?.createdAt ?? open.startAt;
	const quietUntil =
		params.returnedAt && params.returnedAt > reference
			? params.returnedAt
			: now;
	const gapMinutes = Math.max(
		0,
		Math.floor((quietUntil.getTime() - reference.getTime()) / 60_000),
	);
	const needsQuestion =
		gapMinutes >
		(activityInSegment
			? ACTIVITY_GAP_QUESTION_MINUTES
			: NO_ACTIVITY_QUESTION_MINUTES);
	// Only real activity inside the segment is a stop time worth proposing;
	// proposing the segment's own start would save none of it, so without
	// such activity the proposal is now and the member is still asked.
	const proposedMs =
		needsQuestion && activityInSegment
			? activityInSegment.createdAt.getTime()
			: now.getTime();
	return {
		proposedStopAt: new Date(
			Math.min(
				now.getTime(),
				Math.max(open.startAt.getTime(), proposedMs),
			),
		),
		source: activityInSegment
			? {
					action: activityInSegment.action,
					at: activityInSegment.createdAt,
				}
			: null,
		gapMinutes,
		needsQuestion,
	};
}

const SIBLING_ID_PREFIX = "timer-entry-";

type OverDailyLimitWarning = Extract<
	TimeEntryWarning,
	{ code: "OVER_DAILY_LIMIT" }
>;

/**
 * The earliest start to the latest stop of the timed entries, or null when
 * none has both.
 */
function timedSpan(
	entries: readonly TimeEntryFacts[],
): { startAt: Date; stopAt: Date } | null {
	let earliest: Date | null = null;
	let latest: Date | null = null;
	for (const { startAt, stopAt } of entries) {
		if (!startAt || !stopAt) {
			continue;
		}
		if (earliest === null || startAt < earliest) {
			earliest = startAt;
		}
		if (latest === null || stopAt > latest) {
			latest = stopAt;
		}
	}
	return earliest && latest ? { startAt: earliest, stopAt: latest } : null;
}

/**
 * The warnings the entries of one stop raise together, and whether any is
 * not acknowledged yet.
 *
 * Each entry is compared with the member's saved entries on its work date,
 * the saved timed entries that overlap it on any work date, and the entries
 * before it in this stop. Segments of one timer are not
 * duplicates of each other, so only saved entries are named as duplicates;
 * they do count toward the daily total, which is reported once, at its
 * highest.
 */
export async function evaluateTimerEntryWarnings(params: {
	organizationId: string;
	userId: string;
	proposed: readonly TimeEntryFacts[];
	acknowledged: readonly TimeWarningCode[];
}): Promise<{ warnings: TimeEntryWarning[]; blocked: boolean }> {
	const workDates = [
		...new Set(params.proposed.map((entry) => entry.workDate)),
	];
	const savedByDate = new Map(
		await Promise.all(
			workDates.map(
				async (workDate) =>
					[
						workDate,
						await listAuthorTimeEntriesOnWorkDate({
							organizationId: params.organizationId,
							userId: params.userId,
							workDate,
							overlapping: timedSpan(
								params.proposed.filter(
									(entry) => entry.workDate === workDate,
								),
							),
						}),
					] as const,
			),
		),
	);

	const duplicateIds = new Set<string>();
	let overLimit: OverDailyLimitWarning | null = null;
	for (const [index, entry] of params.proposed.entries()) {
		const siblings = params.proposed
			.slice(0, index)
			.map((sibling, siblingIndex) => ({
				...sibling,
				id: `${SIBLING_ID_PREFIX}${siblingIndex}`,
			}));
		const found = detectTimeEntryWarnings({
			proposed: entry,
			existingEntries: [
				...(savedByDate.get(entry.workDate) ?? []),
				...siblings,
			],
		});
		for (const warning of found) {
			switch (warning.code) {
				case "LIKELY_DUPLICATE":
					for (const id of warning.entryIds) {
						if (!id.startsWith(SIBLING_ID_PREFIX)) {
							duplicateIds.add(id);
						}
					}
					break;
				case "OVER_DAILY_LIMIT":
					if (
						!overLimit ||
						warning.totalMinutes > overLimit.totalMinutes
					) {
						overLimit = warning;
					}
					break;
				default: {
					const unreachable: never = warning;
					throw new Error(
						`Unhandled time entry warning: ${String(unreachable)}`,
					);
				}
			}
		}
	}

	const warnings: TimeEntryWarning[] = [
		...(duplicateIds.size > 0
			? [
					{
						code: "LIKELY_DUPLICATE" as const,
						entryIds: [...duplicateIds],
					},
				]
			: []),
		...(overLimit ? [overLimit] : []),
	];
	return {
		warnings,
		blocked: warnings.some(
			(warning) => !params.acknowledged.includes(warning.code),
		),
	};
}
