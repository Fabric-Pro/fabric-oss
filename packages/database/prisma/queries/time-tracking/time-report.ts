/**
 * Time reports: every member's confirmed time over a work-date range, with
 * per-project subtotals and a grand total.
 *
 * This is the single source for a report's rows, its totals and its CSV, so
 * they always reconcile: {@link loadTimeReport} fetches the rows once and
 * {@link summarizeTimeReport} adds them up in code, never with a second query
 * that could see a different row set.
 *
 * Who may read which report is decided by the procedures. What is read here:
 * - entries of the organization, whoever wrote them: someone who has since
 *   left the project or the organization keeps their time in the report, and
 *   so does someone whose account was deleted, under the name saved with the
 *   entry;
 * - never an entry on a soft-deleted project;
 * - the billing-model filter matches the project's CURRENT model, so changing
 *   a project from fixed bid to time and materials moves all of its time.
 *
 * Work dates cross this boundary as `YYYY-MM-DD` strings, as in
 * `./time-entries.ts`.
 */

import { timeEntryAuthorName } from "@repo/utils/time-tracking";
import { db } from "../../client";
import type { ProjectBillingModel, TimeActivity } from "../../generated/client";

/**
 * The most entries one report returns. A year of an organization's time is
 * expected to stay well under it; past it the report is refused with
 * `too_many_rows` rather than cut short, so a total is never silently partial.
 */
export const MAX_TIME_REPORT_ROWS = 20_000;

export interface TimeReportFilters {
	organizationId: string;
	/** First work date, inclusive. */
	from: string;
	/** Last work date, inclusive. */
	to: string;
	projectIds?: readonly string[];
	userIds?: readonly string[];
	/** Entries linked to one of these work items. */
	storyIds?: readonly string[];
	billable?: boolean;
	activity?: TimeActivity;
	/** Matched against each project's current billing model. */
	billingModel?: ProjectBillingModel;
}

export interface TimeReportRow {
	id: string;
	workDate: string;
	timezone: string;
	projectId: string;
	projectName: string;
	/** The project's billing model now, not when the entry was saved. */
	billingModel: ProjectBillingModel;
	/** Null once the author's account is deleted. */
	userId: string | null;
	/** See `timeEntryAuthorName`: never empty, even for a deleted account. */
	userName: string;
	activity: TimeActivity;
	billable: boolean;
	durationMinutes: number;
	description: string | null;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	startAt: Date | null;
	stopAt: Date | null;
}

export interface TimeReportMinutes {
	billableMinutes: number;
	nonBillableMinutes: number;
	totalMinutes: number;
	/** Distinct people with time in the set. */
	peopleCount: number;
}

export interface TimeReportProjectTotal extends TimeReportMinutes {
	projectId: string;
	projectName: string;
	billingModel: ProjectBillingModel;
}

export interface TimeReport {
	rows: TimeReportRow[];
	/** One per project with time in the report, by project name. */
	projects: TimeReportProjectTotal[];
	totals: TimeReportMinutes;
}

export type TimeReportResult =
	| { status: "ok"; report: TimeReport }
	| { status: "too_many_rows"; limit: number };

function workDateToDb(workDate: string): Date {
	return new Date(`${workDate}T00:00:00.000Z`);
}

function workDateFromDb(workDate: Date): string {
	return workDate.toISOString().slice(0, 10);
}

export async function loadTimeReport(
	filters: TimeReportFilters,
): Promise<TimeReportResult> {
	const rows = await db.timeEntry.findMany({
		where: {
			organizationId: filters.organizationId,
			workDate: {
				gte: workDateToDb(filters.from),
				lte: workDateToDb(filters.to),
			},
			project: {
				organizationId: filters.organizationId,
				deletedAt: null,
				...(filters.billingModel
					? { billingModel: filters.billingModel }
					: {}),
			},
			...(filters.projectIds
				? { projectId: { in: [...filters.projectIds] } }
				: {}),
			...(filters.userIds
				? { userId: { in: [...filters.userIds] } }
				: {}),
			...(filters.storyIds
				? { storyId: { in: [...filters.storyIds] } }
				: {}),
			...(filters.billable !== undefined
				? { billable: filters.billable }
				: {}),
			...(filters.activity ? { activity: filters.activity } : {}),
		},
		select: {
			id: true,
			workDate: true,
			timezone: true,
			projectId: true,
			userId: true,
			userNameSnapshot: true,
			activity: true,
			billable: true,
			durationMinutes: true,
			description: true,
			storyId: true,
			storyIdentifier: true,
			storyTitle: true,
			startAt: true,
			stopAt: true,
			project: { select: { name: true, billingModel: true } },
			user: { select: { name: true } },
		},
		orderBy: [
			{ workDate: "asc" },
			{ project: { name: "asc" } },
			{ user: { name: "asc" } },
			{ createdAt: "asc" },
		],
		// One past the cap, to tell "exactly the cap" from "more than it".
		take: MAX_TIME_REPORT_ROWS + 1,
	});
	if (rows.length > MAX_TIME_REPORT_ROWS) {
		return { status: "too_many_rows", limit: MAX_TIME_REPORT_ROWS };
	}

	return {
		status: "ok",
		report: summarizeTimeReport(
			rows.map(
				({ project, user, userNameSnapshot, workDate, ...row }) => ({
					...row,
					workDate: workDateFromDb(workDate),
					projectName: project.name,
					billingModel: project.billingModel,
					userName: timeEntryAuthorName({
						currentName: user?.name ?? null,
						savedName: userNameSnapshot,
					}),
				}),
			),
		),
	};
}

interface MinutesTally {
	billableMinutes: number;
	nonBillableMinutes: number;
	people: Set<string>;
}

function emptyTally(): MinutesTally {
	return { billableMinutes: 0, nonBillableMinutes: 0, people: new Set() };
}

function addRow(tally: MinutesTally, row: TimeReportRow): void {
	if (row.billable) {
		tally.billableMinutes += row.durationMinutes;
	} else {
		tally.nonBillableMinutes += row.durationMinutes;
	}
	tally.people.add(personKey(row));
}

/**
 * Who a row counts as. A deleted account has no id left, so its entries count
 * once per saved name rather than all as one person or each as its own.
 */
function personKey(row: TimeReportRow): string {
	return row.userId ?? `deleted:${row.userName}`;
}

function toMinutes(tally: MinutesTally): TimeReportMinutes {
	return {
		billableMinutes: tally.billableMinutes,
		nonBillableMinutes: tally.nonBillableMinutes,
		totalMinutes: tally.billableMinutes + tally.nonBillableMinutes,
		peopleCount: tally.people.size,
	};
}

/** The per-project subtotals and grand total of exactly these rows. */
export function summarizeTimeReport(rows: TimeReportRow[]): TimeReport {
	const total = emptyTally();
	const byProject = new Map<
		string,
		{ row: TimeReportRow; tally: MinutesTally }
	>();
	for (const row of rows) {
		addRow(total, row);
		const project = byProject.get(row.projectId) ?? {
			row,
			tally: emptyTally(),
		};
		addRow(project.tally, row);
		byProject.set(row.projectId, project);
	}

	const projects = [...byProject.values()]
		.map(({ row, tally }) => ({
			projectId: row.projectId,
			projectName: row.projectName,
			billingModel: row.billingModel,
			...toMinutes(tally),
		}))
		.sort(
			(a, b) =>
				a.projectName.localeCompare(b.projectName) ||
				a.projectId.localeCompare(b.projectId),
		);
	return { rows, projects, totals: toMinutes(total) };
}
