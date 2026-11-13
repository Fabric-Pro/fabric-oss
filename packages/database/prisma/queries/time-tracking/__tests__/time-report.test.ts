/**
 * The time report query and the totals computed from its rows.
 *
 * Prisma's delegate is mocked, so this pins the WHERE the report is read
 * with (tenant, range, soft-deleted projects, each filter, the project's
 * CURRENT billing model), the row cap, and that the subtotals and the grand
 * total are exactly the sum of the returned rows.
 *
 * Run with:
 *   pnpm --filter @repo/database test time-report
 */

import { DELETED_USER_NAME } from "@repo/utils/time-tracking";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	timeEntry: { findMany: vi.fn() },
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: { timeEntry: mocks.timeEntry },
	};
});

const { loadTimeReport, MAX_TIME_REPORT_ROWS, summarizeTimeReport } =
	await import("../time-report");

type BillingModel = "FIXED_BID" | "TIME_AND_MATERIALS";

function dbRow(
	overrides: Partial<{
		id: string;
		workDate: string;
		projectId: string;
		projectName: string;
		billingModel: BillingModel;
		userId: string | null;
		/** The author's current name; null once the account is deleted. */
		userName: string | null;
		userNameSnapshot: string | null;
		billable: boolean;
		durationMinutes: number;
	}> = {},
) {
	const {
		workDate = "2026-03-02",
		projectName = "Example project",
		billingModel = "TIME_AND_MATERIALS",
		userName = "Ada Example",
		...rest
	} = overrides;
	return {
		id: "entry-1",
		timezone: "UTC",
		projectId: "project-1",
		userId: "user-1",
		userNameSnapshot: "Ada Example",
		activity: "DEVELOPMENT",
		billable: true,
		durationMinutes: 60,
		description: null,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startAt: null,
		stopAt: null,
		...rest,
		workDate: new Date(`${workDate}T00:00:00.000Z`),
		project: { name: projectName, billingModel },
		user: userName === null ? null : { name: userName },
	};
}

const RANGE = { organizationId: "org-1", from: "2026-03-01", to: "2026-03-31" };

function whereOfLastCall() {
	return mocks.timeEntry.findMany.mock.calls.at(-1)?.[0].where;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.timeEntry.findMany.mockResolvedValue([]);
});

describe("loadTimeReport", () => {
	it("reads the organization's entries in the range on live projects only", async () => {
		await loadTimeReport(RANGE);

		expect(whereOfLastCall()).toEqual({
			organizationId: "org-1",
			workDate: {
				gte: new Date("2026-03-01T00:00:00.000Z"),
				lte: new Date("2026-03-31T00:00:00.000Z"),
			},
			project: { organizationId: "org-1", deletedAt: null },
		});
	});

	it("never narrows to current members, so a former member's time stays in", async () => {
		await loadTimeReport(RANGE);

		const query = mocks.timeEntry.findMany.mock.calls[0][0];
		expect(JSON.stringify(query.where)).not.toContain("member");
	});

	it("passes every filter through", async () => {
		await loadTimeReport({
			...RANGE,
			projectIds: ["project-1", "project-2"],
			userIds: ["user-2"],
			storyIds: ["story-1"],
			billable: false,
			activity: "TESTING",
			billingModel: "FIXED_BID",
		});

		expect(whereOfLastCall()).toEqual({
			organizationId: "org-1",
			workDate: {
				gte: new Date("2026-03-01T00:00:00.000Z"),
				lte: new Date("2026-03-31T00:00:00.000Z"),
			},
			project: {
				organizationId: "org-1",
				deletedAt: null,
				billingModel: "FIXED_BID",
			},
			projectId: { in: ["project-1", "project-2"] },
			userId: { in: ["user-2"] },
			storyId: { in: ["story-1"] },
			billable: false,
			activity: "TESTING",
		});
	});

	it("keeps a billable: true filter distinct from no billable filter", async () => {
		await loadTimeReport({ ...RANGE, billable: true });
		expect(whereOfLastCall().billable).toBe(true);

		await loadTimeReport(RANGE);
		expect(whereOfLastCall()).not.toHaveProperty("billable");
	});

	it("reports the project's billing model as it is now", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			dbRow({ billingModel: "FIXED_BID" }),
		]);

		const result = await loadTimeReport(RANGE);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.report.rows[0].billingModel).toBe("FIXED_BID");
			expect(result.report.projects[0].billingModel).toBe("FIXED_BID");
		}
	});

	it("asks for one row past the cap and refuses a larger report instead of cutting it short", async () => {
		mocks.timeEntry.findMany.mockResolvedValue(
			Array.from({ length: MAX_TIME_REPORT_ROWS + 1 }, (_, index) =>
				dbRow({ id: `entry-${index}` }),
			),
		);

		const result = await loadTimeReport(RANGE);

		expect(mocks.timeEntry.findMany.mock.calls[0][0].take).toBe(
			MAX_TIME_REPORT_ROWS + 1,
		);
		expect(result).toEqual({
			status: "too_many_rows",
			limit: MAX_TIME_REPORT_ROWS,
		});
	});

	it("returns a report of exactly the cap", async () => {
		mocks.timeEntry.findMany.mockResolvedValue(
			Array.from({ length: MAX_TIME_REPORT_ROWS }, (_, index) =>
				dbRow({ id: `entry-${index}` }),
			),
		);

		const result = await loadTimeReport(RANGE);

		expect(result.status).toBe("ok");
	});

	it("maps rows to work-date strings and flat project and person names", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			dbRow({ workDate: "2026-03-05", userName: "Former Member" }),
		]);

		const result = await loadTimeReport(RANGE);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.report.rows[0]).toMatchObject({
				workDate: "2026-03-05",
				projectName: "Example project",
				userName: "Former Member",
			});
			expect(result.report.rows[0]).not.toHaveProperty("project");
			expect(result.report.rows[0]).not.toHaveProperty("user");
			expect(result.report.rows[0]).not.toHaveProperty(
				"userNameSnapshot",
			);
		}
	});

	it("names a person by their current name while the account exists", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			dbRow({ userName: "Ada Renamed", userNameSnapshot: "Ada Example" }),
		]);

		const result = await loadTimeReport(RANGE);

		expect(result.status === "ok" && result.report.rows[0].userName).toBe(
			"Ada Renamed",
		);
	});

	it("keeps a deleted account's time under the name saved with the entry", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			dbRow({
				userId: null,
				userName: null,
				userNameSnapshot: "Former Member",
			}),
		]);

		const result = await loadTimeReport(RANGE);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.report.rows[0]).toMatchObject({
				userId: null,
				userName: "Former Member",
			});
			expect(result.report.totals.peopleCount).toBe(1);
		}
	});

	it("reads a deleted account with no saved name as a deleted user", async () => {
		mocks.timeEntry.findMany.mockResolvedValue([
			dbRow({ userId: null, userName: null, userNameSnapshot: null }),
		]);

		const result = await loadTimeReport(RANGE);

		expect(result.status === "ok" && result.report.rows[0].userName).toBe(
			DELETED_USER_NAME,
		);
	});

	it("reads the saved name alongside the author", async () => {
		await loadTimeReport(RANGE);

		expect(mocks.timeEntry.findMany.mock.calls[0][0].select).toMatchObject({
			userId: true,
			userNameSnapshot: true,
			user: { select: { name: true } },
		});
	});
});

describe("loadTimeReport: billing model follows the project's current model", () => {
	// The database answers the filter from the project's current column, so a
	// project's entries appear under whichever model it has at read time.
	function stubProjectWithModel(model: BillingModel) {
		mocks.timeEntry.findMany.mockImplementation(
			async (query: {
				where: { project: { billingModel?: string } };
			}) => {
				const wanted = query.where.project.billingModel;
				return wanted === undefined || wanted === model
					? [dbRow({ billingModel: model })]
					: [];
			},
		);
	}

	it("moves a project's time from fixed bid to time and materials", async () => {
		stubProjectWithModel("FIXED_BID");
		const before = await loadTimeReport({
			...RANGE,
			billingModel: "TIME_AND_MATERIALS",
		});

		stubProjectWithModel("TIME_AND_MATERIALS");
		const after = await loadTimeReport({
			...RANGE,
			billingModel: "TIME_AND_MATERIALS",
		});

		expect(before.status === "ok" && before.report.rows).toHaveLength(0);
		expect(after.status === "ok" && after.report.rows).toHaveLength(1);
	});

	it("moves a project's time from time and materials to fixed bid", async () => {
		stubProjectWithModel("TIME_AND_MATERIALS");
		const before = await loadTimeReport({
			...RANGE,
			billingModel: "FIXED_BID",
		});

		stubProjectWithModel("FIXED_BID");
		const after = await loadTimeReport({
			...RANGE,
			billingModel: "FIXED_BID",
		});

		expect(before.status === "ok" && before.report.rows).toHaveLength(0);
		expect(after.status === "ok" && after.report.rows).toHaveLength(1);
	});
});

describe("summarizeTimeReport", () => {
	function row(
		overrides: Partial<{
			id: string;
			projectId: string;
			projectName: string;
			userId: string | null;
			userName: string;
			billable: boolean;
			durationMinutes: number;
		}>,
	) {
		return {
			id: "entry",
			workDate: "2026-03-02",
			timezone: "UTC",
			projectId: "project-a",
			projectName: "Alpha",
			billingModel: "TIME_AND_MATERIALS" as const,
			userId: "user-1",
			userName: "Ada Example",
			activity: "DEVELOPMENT" as const,
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

	const rows = [
		row({ id: "1", durationMinutes: 90, billable: true, userId: "user-1" }),
		row({
			id: "2",
			durationMinutes: 30,
			billable: false,
			userId: "user-2",
		}),
		row({ id: "3", durationMinutes: 45, billable: true, userId: "user-1" }),
		row({
			id: "4",
			projectId: "project-b",
			projectName: "Beta",
			durationMinutes: 120,
			billable: false,
			userId: "user-3",
		}),
	];

	it("splits billable and non-billable minutes per project and counts distinct people", () => {
		const report = summarizeTimeReport(rows);

		expect(report.projects).toEqual([
			{
				projectId: "project-a",
				projectName: "Alpha",
				billingModel: "TIME_AND_MATERIALS",
				billableMinutes: 135,
				nonBillableMinutes: 30,
				totalMinutes: 165,
				peopleCount: 2,
			},
			{
				projectId: "project-b",
				projectName: "Beta",
				billingModel: "TIME_AND_MATERIALS",
				billableMinutes: 0,
				nonBillableMinutes: 120,
				totalMinutes: 120,
				peopleCount: 1,
			},
		]);
		expect(report.totals).toEqual({
			billableMinutes: 135,
			nonBillableMinutes: 150,
			totalMinutes: 285,
			peopleCount: 3,
		});
	});

	it("subtotals and the grand total add up to the sum of the rows", () => {
		const report = summarizeTimeReport(rows);
		const rowSum = rows.reduce((sum, r) => sum + r.durationMinutes, 0);

		expect(report.totals.totalMinutes).toBe(rowSum);
		expect(
			report.projects.reduce((sum, p) => sum + p.totalMinutes, 0),
		).toBe(rowSum);
		expect(
			report.projects.reduce((sum, p) => sum + p.billableMinutes, 0),
		).toBe(report.totals.billableMinutes);
		expect(
			report.projects.reduce((sum, p) => sum + p.nonBillableMinutes, 0),
		).toBe(report.totals.nonBillableMinutes);
	});

	it("counts deleted accounts once per saved name", () => {
		const report = summarizeTimeReport([
			row({ id: "1", userId: null, userName: "Former Member" }),
			row({ id: "2", userId: null, userName: "Former Member" }),
			row({ id: "3", userId: null, userName: "Other Former Member" }),
			row({ id: "4", userId: "user-1", userName: "Ada Example" }),
		]);

		expect(report.totals.peopleCount).toBe(3);
		expect(report.totals.totalMinutes).toBe(240);
	});

	it("returns the rows it was given, unchanged and in order", () => {
		expect(summarizeTimeReport(rows).rows).toBe(rows);
	});

	it("orders projects by name", () => {
		const report = summarizeTimeReport([
			row({ projectId: "z", projectName: "Zulu" }),
			row({ projectId: "a", projectName: "Alpha" }),
		]);
		expect(report.projects.map((p) => p.projectName)).toEqual([
			"Alpha",
			"Zulu",
		]);
	});

	it("is all zeros for no rows", () => {
		expect(summarizeTimeReport([])).toEqual({
			rows: [],
			projects: [],
			totals: {
				billableMinutes: 0,
				nonBillableMinutes: 0,
				totalMinutes: 0,
				peopleCount: 0,
			},
		});
	});
});
