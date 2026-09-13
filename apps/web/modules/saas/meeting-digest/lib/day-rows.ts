import type { AwaitingMeeting, DigestMeeting, PersonalMeeting } from "./types";

/**
 * One row of a single day, tagged with the lane it came from so a caller can
 * still pick the right badge and React key once the lanes are merged.
 */
export type DayRow =
	| { kind: "team"; key: string; at: number; meeting: DigestMeeting }
	| { kind: "awaiting"; key: string; at: number; meeting: AwaitingMeeting }
	| { kind: "personal"; key: string; at: number; meeting: PersonalMeeting };

const timeOf = (value: Date | string | null | undefined): number =>
	value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;

/**
 * Merge a day's lanes into one chronological list.
 *
 * Visibility stays the caller's decision — the calendar shows the earliest rows
 * regardless of kind. This decides the order of the rows it is handed, and a
 * calendar reads by time.
 *
 * Ties keep lane order because the sort is stable and lanes are appended in
 * order. Each row keeps its lane's stable identity, so rows already on screen
 * do not remount.
 */
export function mergeDayRows({
	team = [],
	awaiting = [],
	personal = [],
}: {
	team?: DigestMeeting[];
	awaiting?: AwaitingMeeting[];
	personal?: PersonalMeeting[];
}): DayRow[] {
	const rows: DayRow[] = [
		...team.map(
			(meeting): DayRow => ({
				kind: "team",
				key: meeting.transcriptId,
				at: timeOf(meeting.meetingDate),
				meeting,
			}),
		),
		...awaiting.map(
			(meeting): DayRow => ({
				kind: "awaiting",
				key: `${meeting.linkedMeetingId}:${new Date(meeting.occurrenceStart).toISOString()}`,
				at: timeOf(meeting.occurrenceStart),
				meeting,
			}),
		),
		...personal.map(
			(meeting): DayRow => ({
				kind: "personal",
				key: meeting.id,
				at: timeOf(meeting.startTime),
				meeting,
			}),
		),
	];

	return rows.sort((a, b) => a.at - b.at);
}
