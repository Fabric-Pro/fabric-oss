/**
 * Pure shaping of a loaded time report for the report screen: one expandable
 * row per project with its entries, the people and projects the filters offer,
 * and what a failed read means.
 */

import { ORPCError } from "@orpc/client";
import type { orpcClient } from "@shared/lib/orpc-client";

export type TimeReport = Awaited<
	ReturnType<typeof orpcClient.timeTracking.organizationReport>
>;

export type TimeReportRow = TimeReport["rows"][number];

type TimeReportProject = TimeReport["projects"][number];

export interface ReportTableProject extends TimeReportProject {
	/** The project's entries, in the report's order (by work date). */
	entries: TimeReportRow[];
}

/** The report's projects, in its order, each with its own entries. */
export function buildReportTable(report: TimeReport): ReportTableProject[] {
	const entries = new Map<string, TimeReportRow[]>();
	for (const row of report.rows) {
		const list = entries.get(row.projectId);
		if (list) {
			list.push(row);
		} else {
			entries.set(row.projectId, [row]);
		}
	}
	return report.projects.map((project) => ({
		...project,
		entries: entries.get(project.projectId) ?? [],
	}));
}

export interface ReportOption {
	id: string;
	name: string;
}

function byName(a: ReportOption, b: ReportOption): number {
	return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The projects and people a report's filters can choose from: everyone and
 * every project with time in `report`, once each, by name. A deleted account
 * has no id to filter by, so it is not offered as a person.
 */
export function reportFilterOptions(report: TimeReport): {
	projects: ReportOption[];
	people: ReportOption[];
} {
	const projects = new Map<string, string>();
	const people = new Map<string, string>();
	for (const row of report.rows) {
		projects.set(row.projectId, row.projectName);
		if (row.userId !== null) {
			people.set(row.userId, row.userName);
		}
	}
	const toOptions = (names: Map<string, string>) =>
		[...names].map(([id, name]) => ({ id, name })).sort(byName);
	return { projects: toOptions(projects), people: toOptions(people) };
}

export type ReportFailure = "too-many-rows" | "no-access" | "failed";

/**
 * Why a report read failed. A project the caller may not report on answers
 * NOT_FOUND as often as FORBIDDEN, so both mean no access.
 */
export function reportFailure(error: unknown): ReportFailure {
	if (!(error instanceof ORPCError)) {
		return "failed";
	}
	if (error.code === "FORBIDDEN" || error.code === "NOT_FOUND") {
		return "no-access";
	}
	const data: unknown = error.data;
	if (
		error.code === "BAD_REQUEST" &&
		typeof data === "object" &&
		data !== null &&
		"reason" in data &&
		data.reason === "TOO_MANY_ROWS"
	) {
		return "too-many-rows";
	}
	return "failed";
}
