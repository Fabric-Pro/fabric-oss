/**
 * How a loaded report becomes the screen: entries grouped under their
 * project in the report's order, the filter lists, and what a failed read
 * means to the user.
 */

import { ORPCError } from "@orpc/client";
import {
	buildReportTable,
	reportFailure,
	reportFilterOptions,
	type TimeReport,
	type TimeReportRow,
} from "@saas/time-tracking/lib/report-table";
import { describe, expect, it } from "vitest";

let sequence = 0;

function row(overrides: Partial<TimeReportRow>): TimeReportRow {
	sequence += 1;
	return {
		id: `entry-${sequence}`,
		workDate: "2026-11-02",
		timezone: "Europe/Berlin",
		projectId: "project-a",
		projectName: "Alpha",
		billingModel: "TIME_AND_MATERIALS",
		userId: "user-1",
		userName: "Member A",
		activity: "DEVELOPMENT",
		billable: true,
		durationMinutes: 60,
		description: null,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startAt: null,
		stopAt: null,
		...overrides,
	};
}

function report(rows: TimeReportRow[]): TimeReport {
	return {
		rows,
		projects: [
			{
				projectId: "project-a",
				projectName: "Alpha",
				billingModel: "TIME_AND_MATERIALS",
				billableMinutes: 120,
				nonBillableMinutes: 0,
				totalMinutes: 120,
				peopleCount: 2,
			},
			{
				projectId: "project-b",
				projectName: "Beta",
				billingModel: "FIXED_BID",
				billableMinutes: 0,
				nonBillableMinutes: 30,
				totalMinutes: 30,
				peopleCount: 1,
			},
		],
		totals: {
			billableMinutes: 120,
			nonBillableMinutes: 30,
			totalMinutes: 150,
			peopleCount: 2,
		},
	};
}

describe("buildReportTable", () => {
	it("puts each entry under its project, keeping the report's order", () => {
		const first = row({ workDate: "2026-11-02" });
		const other = row({
			projectId: "project-b",
			projectName: "Beta",
			billable: false,
			durationMinutes: 30,
		});
		const second = row({ workDate: "2026-11-05", userId: "user-2" });

		const table = buildReportTable(report([first, other, second]));

		expect(table.map((project) => project.projectId)).toEqual([
			"project-a",
			"project-b",
		]);
		expect(table[0].entries).toEqual([first, second]);
		expect(table[1].entries).toEqual([other]);
		expect(table[0].peopleCount).toBe(2);
	});

	it("gives a project with no rows an empty list", () => {
		expect(buildReportTable(report([]))[1].entries).toEqual([]);
	});
});

describe("reportFilterOptions", () => {
	it("lists every project and person once, by name", () => {
		const options = reportFilterOptions(
			report([
				row({ userId: "user-2", userName: "Member B" }),
				row({
					projectId: "project-b",
					projectName: "Beta",
					userId: "user-1",
					userName: "Member A",
				}),
				row({ userId: "user-2", userName: "Member B" }),
			]),
		);

		expect(options.projects).toEqual([
			{ id: "project-a", name: "Alpha" },
			{ id: "project-b", name: "Beta" },
		]);
		expect(options.people).toEqual([
			{ id: "user-1", name: "Member A" },
			{ id: "user-2", name: "Member B" },
		]);
	});

	it("does not offer a deleted account as a person to filter by", () => {
		const options = reportFilterOptions(
			report([
				row({ userId: "user-1", userName: "Member A" }),
				row({ userId: null, userName: "Former Member" }),
			]),
		);

		expect(options.people).toEqual([{ id: "user-1", name: "Member A" }]);
	});
});

describe("reportFailure", () => {
	it("reads the row cap refusal as a request to narrow the filters", () => {
		expect(
			reportFailure(
				new ORPCError("BAD_REQUEST", {
					data: { reason: "TOO_MANY_ROWS", limit: 20_000 },
				}),
			),
		).toBe("too-many-rows");
	});

	it("reads a refusal or a hidden project as no access", () => {
		expect(reportFailure(new ORPCError("FORBIDDEN"))).toBe("no-access");
		expect(reportFailure(new ORPCError("NOT_FOUND"))).toBe("no-access");
	});

	it("treats any other error as a failed load", () => {
		expect(reportFailure(new ORPCError("BAD_REQUEST"))).toBe("failed");
		expect(reportFailure(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(
			"failed",
		);
		expect(reportFailure(new Error("network"))).toBe("failed");
	});
});
