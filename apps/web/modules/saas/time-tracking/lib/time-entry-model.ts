/**
 * Pure shaping of the caller's time entries for the My time page and the
 * work-item section: the week table, the day groups, and the values a new
 * entry starts from.
 */

import { addDays, type TimeActivity } from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";

export type TimeEntry = Awaited<
	ReturnType<typeof orpcClient.timeTracking.listEntries>
>["entries"][number];

export type LoggableProject = Awaited<
	ReturnType<typeof orpcClient.timeTracking.listLoggableProjects>
>["projects"][number];

/** The seven work dates of the week that starts on `monday`. */
export function weekDates(monday: string): string[] {
	return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** Confirmed minutes per work date, with every date of `dates` present. */
export function minutesByDate(
	entries: readonly Pick<TimeEntry, "workDate" | "durationMinutes">[],
	dates: readonly string[],
): Record<string, number> {
	const totals: Record<string, number> = Object.fromEntries(
		dates.map((date) => [date, 0]),
	);
	for (const entry of entries) {
		if (entry.workDate in totals) {
			totals[entry.workDate] += entry.durationMinutes;
		}
	}
	return totals;
}

interface WeekTableRow {
	projectId: string;
	projectName: string;
	/** Minutes per work date of the week, in `dates` order. */
	cells: number[];
	totalMinutes: number;
}

export interface WeekTable {
	dates: string[];
	rows: WeekTableRow[];
	/** Minutes per work date across every project, in `dates` order. */
	dayTotals: number[];
	totalMinutes: number;
}

/**
 * One row per project that has time in the week, sorted by project name, with
 * a column per day. Entries outside the week are ignored.
 */
export function buildWeekTable(
	entries: readonly TimeEntry[],
	monday: string,
): WeekTable {
	const dates = weekDates(monday);
	const column = new Map(dates.map((date, index) => [date, index]));
	const rows = new Map<string, WeekTableRow>();

	for (const entry of entries) {
		const index = column.get(entry.workDate);
		if (index === undefined) {
			continue;
		}
		let row = rows.get(entry.projectId);
		if (!row) {
			row = {
				projectId: entry.projectId,
				projectName: entry.projectName,
				cells: dates.map(() => 0),
				totalMinutes: 0,
			};
			rows.set(entry.projectId, row);
		}
		row.cells[index] += entry.durationMinutes;
		row.totalMinutes += entry.durationMinutes;
	}

	const sortedRows = [...rows.values()].sort((a, b) =>
		a.projectName.localeCompare(b.projectName),
	);
	const dayTotals = dates.map((_, index) =>
		sortedRows.reduce((sum, row) => sum + row.cells[index], 0),
	);
	return {
		dates,
		rows: sortedRows,
		dayTotals,
		totalMinutes: dayTotals.reduce((sum, minutes) => sum + minutes, 0),
	};
}

interface ProjectEntryGroup {
	projectId: string;
	projectName: string;
	entries: TimeEntry[];
	totalMinutes: number;
}

/**
 * The entries of one work date grouped by project (sorted by name), each
 * group in the order the entries were logged.
 */
export function groupDayEntries(
	entries: readonly TimeEntry[],
	workDate: string,
): ProjectEntryGroup[] {
	const groups = new Map<string, ProjectEntryGroup>();
	for (const entry of entries) {
		if (entry.workDate !== workDate) {
			continue;
		}
		let group = groups.get(entry.projectId);
		if (!group) {
			group = {
				projectId: entry.projectId,
				projectName: entry.projectName,
				entries: [],
				totalMinutes: 0,
			};
			groups.set(entry.projectId, group);
		}
		group.entries.push(entry);
		group.totalMinutes += entry.durationMinutes;
	}
	const sorted = [...groups.values()].sort((a, b) =>
		a.projectName.localeCompare(b.projectName),
	);
	for (const group of sorted) {
		group.entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	return sorted;
}

const DEFAULT_TIME_ACTIVITY: TimeActivity = "DEVELOPMENT";

/**
 * The project and activity a new entry starts from: the caller's most
 * recently logged entry on a project they can still log to, else the first
 * loggable project and Development. `null` project when there is none.
 */
export function newEntryDefaults(
	entries: readonly Pick<TimeEntry, "projectId" | "activity" | "createdAt">[],
	projects: readonly Pick<LoggableProject, "id">[],
): { projectId: string | null; activity: TimeActivity } {
	const loggable = new Set(projects.map((project) => project.id));
	const latest = entries
		.filter((entry) => loggable.has(entry.projectId))
		.reduce<(typeof entries)[number] | null>(
			(newest, entry) =>
				newest === null || entry.createdAt > newest.createdAt
					? entry
					: newest,
			null,
		);
	if (latest) {
		return { projectId: latest.projectId, activity: latest.activity };
	}
	return {
		projectId: projects[0]?.id ?? null,
		activity: DEFAULT_TIME_ACTIVITY,
	};
}
