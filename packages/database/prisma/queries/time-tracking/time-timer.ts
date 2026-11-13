/**
 * The running timer: the reads and writes behind `timeTracking.timer.*`, the
 * member's time-tracking preferences, and the activity a proposed stop time
 * is read from.
 *
 * A timer is personal. Every function is scoped by the owner's `userId` and
 * the organization: nobody reads or changes another member's timer, whatever
 * their role. Every change is a compare-and-set on the timer's `version`, so
 * a change made from a stale view matches nothing (`null`) and the procedure
 * answers with the current state. Which projects the member may time is
 * decided by the procedures, as for entries.
 *
 * Stopping a timer creates entries, so it lives with the entry writes
 * (`stopTimeTimer` in `./time-entries`).
 */

import { db } from "../../client";
import type {
	TimeActivity,
	TimeTimerStatus,
	TimeTimerWidget,
} from "../../generated/client";
import { isUniqueViolation } from "../projects/publishing-tenant-lock";

export interface TimeTimerSegmentRow {
	startAt: Date;
	stopAt: Date | null;
}

export interface TimeTimerRow {
	id: string;
	organizationId: string;
	projectId: string;
	projectName: string;
	activity: TimeActivity;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	description: string | null;
	billable: boolean | null;
	timezone: string;
	status: TimeTimerStatus;
	version: number;
	createdAt: Date;
	updatedAt: Date;
	/** Oldest first. At most the last one is open. */
	segments: TimeTimerSegmentRow[];
}

const timeTimerSelect = {
	id: true,
	organizationId: true,
	projectId: true,
	activity: true,
	storyId: true,
	storyIdentifier: true,
	storyTitle: true,
	description: true,
	billable: true,
	timezone: true,
	status: true,
	version: true,
	createdAt: true,
	updatedAt: true,
	project: { select: { name: true } },
	segments: {
		select: { startAt: true, stopAt: true },
		orderBy: { startAt: "asc" },
	},
} as const;

function toTimeTimerRow({
	project,
	...timer
}: {
	project: { name: string };
} & Omit<TimeTimerRow, "projectName">): TimeTimerRow {
	return { ...timer, projectName: project.name };
}

/** The member's timer in the organization, or null. */
export async function findTimeTimerForOwner(params: {
	organizationId: string;
	userId: string;
}): Promise<TimeTimerRow | null> {
	const row = await db.timeTimer.findUnique({
		where: {
			organizationId_userId: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
		},
		select: timeTimerSelect,
	});
	return row ? toTimeTimerRow(row) : null;
}

/** What the member is timing; the procedures resolve and validate it. */
interface TimeTimerValues {
	projectId: string;
	activity: TimeActivity;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	description: string | null;
	/** Null takes the project's billable default when the timer stops. */
	billable: boolean | null;
}

type StartTimeTimerResult =
	| { status: "started"; timer: TimeTimerRow }
	/** The member already has a timer in the organization: that one. */
	| { status: "exists"; timer: TimeTimerRow };

/**
 * Start a running timer for the member with its first segment open at
 * `startAt`, unless they already have one.
 *
 * One transaction with the preference change a start makes: a widget closed
 * until the next start (`HIDDEN_UNTIL_START`) shows again; one turned `OFF`
 * stays off. Two concurrent starts race on the unique (organization, member)
 * index, and the loser answers `exists` with the winner's timer.
 */
export async function startTimeTimer(params: {
	organizationId: string;
	userId: string;
	timezone: string;
	values: TimeTimerValues;
	startAt: Date;
}): Promise<StartTimeTimerResult> {
	try {
		return await db.$transaction(async (tx) => {
			const row = await tx.timeTimer.create({
				data: {
					...params.values,
					organizationId: params.organizationId,
					userId: params.userId,
					timezone: params.timezone,
					segments: {
						create: {
							organizationId: params.organizationId,
							userId: params.userId,
							startAt: params.startAt,
						},
					},
				},
				select: timeTimerSelect,
			});
			await tx.timeTrackingPreference.updateMany({
				where: {
					organizationId: params.organizationId,
					userId: params.userId,
					timerWidget: "HIDDEN_UNTIL_START",
				},
				data: { timerWidget: "SHOWN" },
			});
			return { status: "started" as const, timer: toTimeTimerRow(row) };
		});
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		const existing = await findTimeTimerForOwner(params);
		if (!existing) {
			throw error;
		}
		return { status: "exists", timer: existing };
	}
}

interface TimerVersionKey {
	timerId: string;
	organizationId: string;
	userId: string;
	version: number;
}

function versionWhere(key: TimerVersionKey) {
	return {
		id: key.timerId,
		organizationId: key.organizationId,
		userId: key.userId,
		version: key.version,
	};
}

/**
 * Pause the member's RUNNING timer at `at`, closing its open segment.
 * Null when the timer is not at `version` or not running.
 *
 * The segment closes no earlier than it opened, so an application clock a
 * little behind the one that opened it cannot break the stop-after-start
 * constraint.
 */
export async function pauseTimeTimer(
	params: TimerVersionKey & { at: Date },
): Promise<TimeTimerRow | null> {
	return db.$transaction(async (tx) => {
		const moved = await tx.timeTimer.updateMany({
			where: { ...versionWhere(params), status: "RUNNING" },
			data: { status: "PAUSED", version: { increment: 1 } },
		});
		if (moved.count === 0) {
			return null;
		}
		const open = await tx.timeTimerSegment.findFirst({
			where: {
				timerId: params.timerId,
				userId: params.userId,
				stopAt: null,
			},
			select: { id: true, startAt: true },
		});
		if (open) {
			await tx.timeTimerSegment.update({
				where: { id: open.id },
				data: {
					stopAt: new Date(
						Math.max(params.at.getTime(), open.startAt.getTime()),
					),
				},
			});
		}
		const row = await tx.timeTimer.findUniqueOrThrow({
			where: { id: params.timerId },
			select: timeTimerSelect,
		});
		return toTimeTimerRow(row);
	});
}

/**
 * Resume the member's PAUSED timer at `at`, opening a new segment. Null when
 * the timer is not at `version` or not paused.
 */
export async function resumeTimeTimer(
	params: TimerVersionKey & { at: Date },
): Promise<TimeTimerRow | null> {
	return db.$transaction(async (tx) => {
		const moved = await tx.timeTimer.updateMany({
			where: { ...versionWhere(params), status: "PAUSED" },
			data: { status: "RUNNING", version: { increment: 1 } },
		});
		if (moved.count === 0) {
			return null;
		}
		await tx.timeTimerSegment.create({
			data: {
				timerId: params.timerId,
				organizationId: params.organizationId,
				userId: params.userId,
				startAt: params.at,
			},
		});
		const row = await tx.timeTimer.findUniqueOrThrow({
			where: { id: params.timerId },
			select: timeTimerSelect,
		});
		return toTimeTimerRow(row);
	});
}

/**
 * Replace what the member's timer is timing. Null when the timer is not at
 * `version`.
 */
export async function updateTimeTimer(
	params: TimerVersionKey & { values: TimeTimerValues },
): Promise<TimeTimerRow | null> {
	return db.$transaction(async (tx) => {
		const moved = await tx.timeTimer.updateMany({
			where: versionWhere(params),
			data: { ...params.values, version: { increment: 1 } },
		});
		if (moved.count === 0) {
			return null;
		}
		const row = await tx.timeTimer.findUniqueOrThrow({
			where: { id: params.timerId },
			select: timeTimerSelect,
		});
		return toTimeTimerRow(row);
	});
}

interface TimeTrackingPreferenceValues {
	timerWidget: TimeTimerWidget;
	timerReminders: boolean;
}

/** What a member without a preference row gets. Matches the column defaults. */
const DEFAULT_TIME_TRACKING_PREFERENCE: TimeTrackingPreferenceValues = {
	timerWidget: "SHOWN",
	timerReminders: false,
};

const preferenceSelect = { timerWidget: true, timerReminders: true } as const;

/** The member's preferences in the organization, defaults when unset. */
export async function getTimeTrackingPreference(params: {
	organizationId: string;
	userId: string;
}): Promise<TimeTrackingPreferenceValues> {
	const row = await db.timeTrackingPreference.findUnique({
		where: {
			organizationId_userId: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
		},
		select: preferenceSelect,
	});
	return row ?? DEFAULT_TIME_TRACKING_PREFERENCE;
}

/** Change the member's preferences; omitted fields are kept. */
export async function setTimeTrackingPreference(params: {
	organizationId: string;
	userId: string;
	values: Partial<TimeTrackingPreferenceValues>;
}): Promise<TimeTrackingPreferenceValues> {
	return db.timeTrackingPreference.upsert({
		where: {
			organizationId_userId: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
		},
		create: {
			...DEFAULT_TIME_TRACKING_PREFERENCE,
			...params.values,
			organizationId: params.organizationId,
			userId: params.userId,
		},
		update: params.values,
		select: preferenceSelect,
	});
}

/**
 * The member's newest or oldest successful action of their own in the
 * organization in `(after, before)`, from the audit log, or null.
 *
 * Only rows the member wrote while signed in as themselves (`actorType`
 * `user`, not impersonated), and none whose action starts with
 * `excludeActionPrefix`: the timer's own calls must not count as work, or
 * pressing Stop would always look like the last thing the member did.
 * Failed calls are left out too: a refused Stop is logged as an `error.*`
 * row, which the prefix would not catch.
 */
export async function findOwnActivity(params: {
	organizationId: string;
	userId: string;
	after: Date;
	before: Date;
	excludeActionPrefix: string;
	pick: "newest" | "oldest";
}): Promise<{ action: string; createdAt: Date } | null> {
	return db.auditLog.findFirst({
		where: {
			userId: params.userId,
			organizationId: params.organizationId,
			actorType: "user",
			impersonatedById: null,
			outcome: "success",
			createdAt: { gt: params.after, lt: params.before },
			NOT: { action: { startsWith: params.excludeActionPrefix } },
		},
		select: { action: true, createdAt: true },
		orderBy: { createdAt: params.pick === "newest" ? "desc" : "asc" },
	});
}
