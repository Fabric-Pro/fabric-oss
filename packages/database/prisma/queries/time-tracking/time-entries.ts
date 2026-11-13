/**
 * Manual time tracking: the reads and writes behind `timeTracking.*`.
 *
 * Every function is scoped by `organizationId`, the tenant boundary, and the
 * entry reads and writes are also scoped by the author's `userId`: a member
 * only ever reads or changes their own entries here. An entry whose author's
 * account was deleted has a null `userId`, so it is nobody's own. Organization-
 * wide reports read the same table elsewhere.
 *
 * Who may log time on which project is not decided here; the procedures
 * resolve that from the caller's project and organization roles. These
 * functions return the rows that decision needs.
 *
 * Work dates cross this boundary as `YYYY-MM-DD` strings (see `./work-date`).
 */

import { db } from "../../client";
import type {
	ProjectBillingModel,
	ProjectStatus,
	TimeActivity,
	TimeTimerStopOutcome,
} from "../../generated/client";
import { workDateFromDb, workDateToDb } from "./work-date";

/** The time policy settings of an organization or a project. */
export interface TimePolicyRow {
	timeRequireStartStop: boolean;
	timeDefaultBillable: boolean | null;
}

export interface TimeTrackingProject extends TimePolicyRow {
	id: string;
	name: string;
	organizationId: string | null;
	deletedAt: Date | null;
	status: ProjectStatus;
	billingModel: ProjectBillingModel;
	organization: TimePolicyRow | null;
}

const timeTrackingProjectSelect = {
	id: true,
	name: true,
	organizationId: true,
	deletedAt: true,
	status: true,
	billingModel: true,
	timeRequireStartStop: true,
	timeDefaultBillable: true,
	organization: {
		select: {
			timeRequireStartStop: true,
			timeDefaultBillable: true,
		},
	},
} as const;

/** A project with what saving a time entry on it needs: tenancy and policy. */
export async function loadTimeTrackingProject(
	projectId: string,
): Promise<TimeTrackingProject | null> {
	return db.project.findUnique({
		where: { id: projectId },
		select: timeTrackingProjectSelect,
	});
}

/** The project settings an administrator changes; omitted fields are kept. */
export interface ProjectTimeSettingsValues {
	billingModel?: ProjectBillingModel;
	timeRequireStartStop?: boolean;
	/** `null` inherits the organization's default. */
	timeDefaultBillable?: boolean | null;
}

/**
 * Change a project's billing model and time policy. Existing entries are not
 * touched: each keeps the start/stop rule and billable flag it was saved with.
 */
export async function updateProjectTimeSettings(params: {
	projectId: string;
	values: ProjectTimeSettingsValues;
}): Promise<TimeTrackingProject> {
	return db.project.update({
		where: { id: params.projectId },
		data: params.values,
		select: timeTrackingProjectSelect,
	});
}

/** An organization's time policy, or null when there is no such organization. */
export async function loadOrganizationTimePolicy(
	organizationId: string,
): Promise<TimePolicyRow | null> {
	return db.organization.findUnique({
		where: { id: organizationId },
		select: { timeRequireStartStop: true, timeDefaultBillable: true },
	});
}

/**
 * Change an organization's time policy; omitted fields are kept. Like the
 * project settings, it applies to new entries only.
 */
export async function updateOrganizationTimePolicy(params: {
	organizationId: string;
	values: Partial<TimePolicyRow>;
}): Promise<TimePolicyRow> {
	return db.organization.update({
		where: { id: params.organizationId },
		data: params.values,
		select: { timeRequireStartStop: true, timeDefaultBillable: true },
	});
}

export interface TimeAccessMemberRow {
	role: string;
	acceptedAt: Date | null;
	expiresAt: Date | null;
}

export interface TimeAccessProjectRow extends TimePolicyRow {
	id: string;
	name: string;
	billingModel: ProjectBillingModel;
	/** The caller's own ProjectMember row on the project, if any. */
	member: TimeAccessMemberRow | null;
	/** Whether the caller created the project. */
	ownedByCaller: boolean;
}

export interface TimeAccessRows {
	/** The caller's role in the organization, or null for a non-member. */
	organizationRole: string | null;
	organization: TimePolicyRow | null;
	projects: TimeAccessProjectRow[];
}

/**
 * Which of the organization's live (not soft-deleted) projects to read:
 * - `"loggable"`: the ACTIVE ones, the only projects that accept new time;
 * - `{ ids }`: these projects whatever their status, so entries logged before
 *   a project was archived or completed stay readable.
 */
export type TimeAccessProjects = "loggable" | { ids: readonly string[] };

/**
 * The organization's projects selected by `projects`, each with the caller's
 * own ProjectMember row, plus the caller's organization role. Three queries
 * however many projects there are, so the procedures can resolve the caller's
 * permission on every project without one lookup each.
 */
export async function listTimeAccessRows(params: {
	organizationId: string;
	userId: string;
	projects: TimeAccessProjects;
}): Promise<TimeAccessRows> {
	const projectFilter =
		params.projects === "loggable"
			? { status: "ACTIVE" as const }
			: { id: { in: [...params.projects.ids] } };
	const [membership, organization, projects] = await Promise.all([
		db.member.findFirst({
			where: {
				organizationId: params.organizationId,
				userId: params.userId,
			},
			select: { role: true },
		}),
		db.organization.findUnique({
			where: { id: params.organizationId },
			select: { timeRequireStartStop: true, timeDefaultBillable: true },
		}),
		db.project.findMany({
			where: {
				organizationId: params.organizationId,
				deletedAt: null,
				...projectFilter,
			},
			select: {
				id: true,
				name: true,
				userId: true,
				billingModel: true,
				timeRequireStartStop: true,
				timeDefaultBillable: true,
				members: {
					where: { userId: params.userId },
					select: { role: true, acceptedAt: true, expiresAt: true },
					take: 1,
				},
			},
			orderBy: { name: "asc" },
		}),
	]);

	return {
		organizationRole: membership?.role ?? null,
		organization,
		projects: projects.map(({ members, userId, ...project }) => ({
			...project,
			member: members[0] ?? null,
			ownedByCaller: userId === params.userId,
		})),
	};
}

export interface TimeEntryRow {
	id: string;
	organizationId: string;
	projectId: string;
	projectName: string;
	workDate: string;
	timezone: string;
	durationMinutes: number;
	startAt: Date | null;
	stopAt: Date | null;
	activity: TimeActivity;
	billable: boolean;
	description: string | null;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	startStopRequired: boolean;
	createdAt: Date;
	updatedAt: Date;
}

const timeEntrySelect = {
	id: true,
	organizationId: true,
	projectId: true,
	workDate: true,
	timezone: true,
	durationMinutes: true,
	startAt: true,
	stopAt: true,
	activity: true,
	billable: true,
	description: true,
	storyId: true,
	storyIdentifier: true,
	storyTitle: true,
	startStopRequired: true,
	createdAt: true,
	updatedAt: true,
	project: { select: { name: true } },
} as const;

function toTimeEntryRow({
	project,
	workDate,
	...entry
}: {
	project: { name: string };
	workDate: Date;
} & Omit<TimeEntryRow, "projectName" | "workDate">): TimeEntryRow {
	return {
		...entry,
		projectName: project.name,
		workDate: workDateFromDb(workDate),
	};
}

/** The author's entries with a work date in `[from, to]`, oldest first. */
export async function listTimeEntriesForAuthor(params: {
	organizationId: string;
	userId: string;
	from: string;
	to: string;
}): Promise<TimeEntryRow[]> {
	const rows = await db.timeEntry.findMany({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
			workDate: {
				gte: workDateToDb(params.from),
				lte: workDateToDb(params.to),
			},
		},
		select: timeEntrySelect,
		orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
	});
	return rows.map(toTimeEntryRow);
}

/** The author's entries on one work item, oldest first. */
export async function listTimeEntriesForAuthorStory(params: {
	organizationId: string;
	projectId: string;
	storyId: string;
	userId: string;
}): Promise<TimeEntryRow[]> {
	const rows = await db.timeEntry.findMany({
		where: {
			organizationId: params.organizationId,
			projectId: params.projectId,
			storyId: params.storyId,
			userId: params.userId,
		},
		select: timeEntrySelect,
		orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
	});
	return rows.map(toTimeEntryRow);
}

/** One of the author's entries, or null when it is not theirs or not there. */
export async function findTimeEntryForAuthor(params: {
	id: string;
	userId: string;
}): Promise<TimeEntryRow | null> {
	const row = await db.timeEntry.findFirst({
		where: { id: params.id, userId: params.userId },
		select: timeEntrySelect,
	});
	return row ? toTimeEntryRow(row) : null;
}

export interface SameDayTimeEntryRow {
	id: string;
	projectId: string;
	workDate: string;
	durationMinutes: number;
	startAt: Date | null;
	stopAt: Date | null;
	activity: TimeActivity;
	storyId: string | null;
	description: string | null;
}

/**
 * The author's entries on one work date across every project of the
 * organization: what duplicate and daily-total warnings compare against.
 *
 * With `overlapping`, the author's timed entries whose `[startAt, stopAt)`
 * overlaps that span are returned too, whatever their work date, so an
 * overnight entry that overlaps the next day's entry is still compared. The
 * caller sums only the rows on its own work date toward the daily total.
 */
export async function listAuthorTimeEntriesOnWorkDate(params: {
	organizationId: string;
	userId: string;
	workDate: string;
	overlapping?: { startAt: Date; stopAt: Date } | null;
}): Promise<SameDayTimeEntryRow[]> {
	const onWorkDate = { workDate: workDateToDb(params.workDate) };
	const rows = await db.timeEntry.findMany({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
			...(params.overlapping
				? {
						OR: [
							onWorkDate,
							{
								startAt: { lt: params.overlapping.stopAt },
								stopAt: { gt: params.overlapping.startAt },
							},
						],
					}
				: onWorkDate),
		},
		select: {
			id: true,
			projectId: true,
			workDate: true,
			durationMinutes: true,
			startAt: true,
			stopAt: true,
			activity: true,
			storyId: true,
			description: true,
		},
	});
	return rows.map(({ workDate, ...row }) => ({
		...row,
		workDate: workDateFromDb(workDate),
	}));
}

/**
 * The time zone on the user's profile, as stored. Null when none is set.
 * Validity is for the caller to decide.
 */
export async function findUserProfileTimeZone(
	userId: string,
): Promise<string | null> {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { timezone: true },
	});
	return user?.timezone ?? null;
}

/** A work item of `projectId`, or null when it belongs to another project. */
export async function findStoryForTimeEntry(params: {
	projectId: string;
	storyId: string;
}): Promise<{ id: string; identifier: string; title: string } | null> {
	return db.userStory.findFirst({
		where: { id: params.storyId, projectId: params.projectId },
		select: { id: true, identifier: true, title: true },
	});
}

/** Every field a saved entry carries, as the procedures decide them. */
export interface TimeEntryValues {
	projectId: string;
	workDate: string;
	timezone: string;
	durationMinutes: number;
	startAt: Date | null;
	stopAt: Date | null;
	activity: TimeActivity;
	billable: boolean;
	description: string | null;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	startStopRequired: boolean;
	/**
	 * The author's name now. Written on every save, so a report can still name
	 * them after their account is deleted.
	 */
	userNameSnapshot: string;
}

export async function createTimeEntry(params: {
	organizationId: string;
	userId: string;
	values: TimeEntryValues;
}): Promise<TimeEntryRow> {
	const row = await db.timeEntry.create({
		data: {
			...params.values,
			workDate: workDateToDb(params.values.workDate),
			organizationId: params.organizationId,
			userId: params.userId,
		},
		select: timeEntrySelect,
	});
	return toTimeEntryRow(row);
}

/**
 * Replace an entry's values. Addressed by id AND author, so a caller that
 * skipped the ownership check still cannot change someone else's entry; it
 * fails with Prisma's not-found error instead.
 */
export async function updateTimeEntry(params: {
	id: string;
	userId: string;
	values: TimeEntryValues;
}): Promise<TimeEntryRow> {
	const row = await db.timeEntry.update({
		where: { id: params.id, userId: params.userId },
		data: {
			...params.values,
			workDate: workDateToDb(params.values.workDate),
		},
		select: timeEntrySelect,
	});
	return toTimeEntryRow(row);
}

/** Delete one of the author's entries. Returns whether a row was removed. */
export async function deleteTimeEntry(params: {
	id: string;
	userId: string;
}): Promise<boolean> {
	const { count } = await db.timeEntry.deleteMany({
		where: { id: params.id, userId: params.userId },
	});
	return count > 0;
}

/**
 * What the author has already logged over a suggestion window, across every
 * project of the organization, in one read: the time a suggestion must not
 * offer again.
 *
 * `intervals` are the start and stop of their timed entries that overlap
 * `[from, to)`. `entries` are where every entry with a work date in
 * `[fromDate, toDate]` puts its time, whether it was saved with times or a
 * duration only.
 */
export async function listAuthorLoggedTime(params: {
	organizationId: string;
	userId: string;
	from: Date;
	to: Date;
	fromDate: string;
	toDate: string;
}): Promise<{
	intervals: { startAt: Date; endAt: Date }[];
	entries: { projectId: string; workDate: string; storyId: string | null }[];
}> {
	const fromDate = workDateToDb(params.fromDate);
	const toDate = workDateToDb(params.toDate);
	const rows = await db.timeEntry.findMany({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
			OR: [
				{ startAt: { lt: params.to }, stopAt: { gt: params.from } },
				{ workDate: { gte: fromDate, lte: toDate } },
			],
		},
		select: {
			projectId: true,
			workDate: true,
			storyId: true,
			startAt: true,
			stopAt: true,
		},
	});
	return {
		intervals: rows.flatMap((row) =>
			row.startAt &&
			row.stopAt &&
			row.startAt < params.to &&
			row.stopAt > params.from
				? [{ startAt: row.startAt, endAt: row.stopAt }]
				: [],
		),
		entries: rows.flatMap((row) =>
			row.workDate >= fromDate && row.workDate <= toDate
				? [
						{
							projectId: row.projectId,
							workDate: workDateFromDb(row.workDate),
							storyId: row.storyId,
						},
					]
				: [],
		),
	};
}

/** The author's entry confirmed from a suggestion, or null. */
export async function findTimeEntryForSuggestion(params: {
	suggestionId: string;
	userId: string;
}): Promise<TimeEntryRow | null> {
	const row = await db.timeEntry.findFirst({
		where: {
			sourceSuggestionId: params.suggestionId,
			userId: params.userId,
		},
		select: timeEntrySelect,
	});
	return row ? toTimeEntryRow(row) : null;
}

export type ConfirmTimeSuggestionOutcome =
	/** This call confirmed the suggestion and created its entry. */
	| { status: "created"; entry: TimeEntryRow }
	/** Already confirmed, by an earlier or a concurrent call: its entry. */
	| { status: "existing"; entry: TimeEntryRow }
	/** Dismissed, or confirmed and its entry since deleted. */
	| { status: "not_pending" };

/**
 * Confirm one of the owner's PENDING suggestions as a time entry, exactly
 * once.
 *
 * One transaction: the suggestion moves PENDING to CONFIRMED by a conditional
 * update, the entry is created carrying the suggestion's id, and the
 * suggestion records the entry's id. Two confirms of the same suggestion
 * serialize on the suggestion row; the one that finds it no longer PENDING
 * returns the entry the other created instead of creating a second, and
 * `time_entry.sourceSuggestionId` is unique besides.
 */
export async function confirmTimeSuggestionAsEntry(params: {
	suggestionId: string;
	organizationId: string;
	userId: string;
	values: TimeEntryValues;
}): Promise<ConfirmTimeSuggestionOutcome> {
	return db.$transaction(async (tx) => {
		const claimed = await tx.timeSuggestion.updateMany({
			where: {
				id: params.suggestionId,
				organizationId: params.organizationId,
				userId: params.userId,
				status: "PENDING",
			},
			data: { status: "CONFIRMED" },
		});
		if (claimed.count === 0) {
			const existing = await tx.timeEntry.findFirst({
				where: {
					sourceSuggestionId: params.suggestionId,
					userId: params.userId,
				},
				select: timeEntrySelect,
			});
			return existing
				? {
						status: "existing" as const,
						entry: toTimeEntryRow(existing),
					}
				: { status: "not_pending" as const };
		}

		const row = await tx.timeEntry.create({
			data: {
				...params.values,
				workDate: workDateToDb(params.values.workDate),
				organizationId: params.organizationId,
				userId: params.userId,
				sourceSuggestionId: params.suggestionId,
			},
			select: timeEntrySelect,
		});
		await tx.timeSuggestion.update({
			where: { id: params.suggestionId },
			data: { confirmedEntryId: row.id },
		});
		return { status: "created" as const, entry: toTimeEntryRow(row) };
	});
}

/** How long a stopped timer's outcome is kept for a repeated stop. */
const TIME_TIMER_STOP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Stop the member's timer at `version`, exactly once: delete it, create
 * `entries` (none discards it), and record the outcome under the timer's id.
 *
 * One transaction. The delete is a compare-and-set on the version, so the
 * entries, planned from the segments of that version, are the ones saved.
 * Two stops of the same timer serialize on its row; the one that deletes
 * nothing answers `false`, and {@link findTimeTimerStop} then gives it what
 * the other saved. Outcomes older than a day are pruned on the way.
 *
 * Returns the created entries, or null when the timer is not at `version`
 * (stopped, discarded or changed since).
 */
export async function stopTimeTimer(params: {
	timerId: string;
	organizationId: string;
	userId: string;
	version: number;
	entries: readonly TimeEntryValues[];
	now: Date;
}): Promise<TimeEntryRow[] | null> {
	return db.$transaction(async (tx) => {
		const deleted = await tx.timeTimer.deleteMany({
			where: {
				id: params.timerId,
				organizationId: params.organizationId,
				userId: params.userId,
				version: params.version,
			},
		});
		if (deleted.count === 0) {
			return null;
		}

		const created: TimeEntryRow[] = [];
		for (const values of params.entries) {
			const row = await tx.timeEntry.create({
				data: {
					...values,
					workDate: workDateToDb(values.workDate),
					organizationId: params.organizationId,
					userId: params.userId,
				},
				select: timeEntrySelect,
			});
			created.push(toTimeEntryRow(row));
		}

		await tx.timeTimerStop.create({
			data: {
				timerId: params.timerId,
				organizationId: params.organizationId,
				userId: params.userId,
				version: params.version,
				outcome: created.length > 0 ? "SAVED" : "DISCARDED",
				entryIds: created.map((entry) => entry.id),
			},
		});
		await tx.timeTimerStop.deleteMany({
			where: {
				userId: params.userId,
				createdAt: {
					lt: new Date(
						params.now.getTime() - TIME_TIMER_STOP_RETENTION_MS,
					),
				},
			},
		});
		return created;
	});
}

interface TimeTimerStopRow {
	version: number;
	outcome: TimeTimerStopOutcome;
	/** The entries it saved that still exist. */
	entries: TimeEntryRow[];
}

/** What became of the member's stopped timer, or null when unknown. */
export async function findTimeTimerStop(params: {
	timerId: string;
	userId: string;
}): Promise<TimeTimerStopRow | null> {
	const stop = await db.timeTimerStop.findFirst({
		where: { timerId: params.timerId, userId: params.userId },
		select: { version: true, outcome: true, entryIds: true },
	});
	if (!stop) {
		return null;
	}
	const rows =
		stop.entryIds.length > 0
			? await db.timeEntry.findMany({
					where: { id: { in: stop.entryIds }, userId: params.userId },
					select: timeEntrySelect,
					orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
				})
			: [];
	return {
		version: stop.version,
		outcome: stop.outcome,
		entries: rows.map(toTimeEntryRow),
	};
}
