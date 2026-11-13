/**
 * The project and organization time reports and their CSV exports.
 *
 * Same seams as `time-tracking.test.ts`: the permission and visibility
 * middleware are pinned by their declaration, and `loadTimeReport` and
 * `loadTimeTrackingProject` are mocked. `summarizeTimeReport` runs for real
 * inside the mock, so the screen's totals and the CSV are computed from the
 * same rows the way production computes them. `recordAuditFromRequest` is
 * mocked so the audit row each export leaves can be read back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadTimeReport: vi.fn(),
	loadTimeTrackingProject: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		loadTimeReport: mocks.loadTimeReport,
		loadTimeTrackingProject: mocks.loadTimeTrackingProject,
	};
});

type Declaration = {
	kind: string;
	permission?: string;
	options?: { requireOrganization?: boolean };
};

const VISIBLE: Declaration = { kind: "visible" };

vi.mock("../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
	projectNotFoundUnlessVisible: { kind: "visible" },
}));
type Handler = (args: { input: unknown; context: unknown }) => Promise<any>;

vi.mock("../../../../orpc/procedures", async () => {
	const { Permissions } = await import("@repo/permissions");
	const builder = (declared: Declaration[]): any => ({
		use: (declaration: Declaration) => builder([...declared, declaration]),
		route: () => builder(declared),
		input: () => builder(declared),
		output: () => builder(declared),
		handler: (fn: Handler) => ({ __handler: fn, __declared: declared }),
	});
	return {
		Permissions,
		tenantProtectedProcedure: builder([]),
		requireProjectPermission: (permission: string) => ({
			kind: "project",
			permission,
		}),
		requireInputOrgPermission: (
			permission: string,
			options?: { requireOrganization?: boolean },
		) => ({ kind: "input-org", permission, options }),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

const { Permissions } = await import("@repo/permissions");
// Not mocked above, so this is the real aggregation.
const { summarizeTimeReport } = await import("@repo/database");
const {
	exportProjectTimeReportCsvProcedure,
	projectTimeReportInputSchema,
	projectTimeReportProcedure,
} = await import("../project-report");
const {
	exportOrganizationTimeReportCsvProcedure,
	organizationTimeReportInputSchema,
	organizationTimeReportProcedure,
} = await import("../organization-report");
const { TIME_REPORT_CSV_HEADER } = await import("../../lib/report-csv");

type StubbedProcedure = { __handler: Handler; __declared: Declaration[] };

function stub(procedure: unknown): StubbedProcedure {
	return procedure as StubbedProcedure;
}

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";
const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: ORG_ID },
};

function call(
	procedure: unknown,
	schema: { parse: (input: unknown) => unknown },
	input: unknown,
) {
	return stub(procedure).__handler({ input: schema.parse(input), context });
}

type ReportRow = Parameters<typeof summarizeTimeReport>[0][number];

function reportRow(overrides: Partial<ReportRow> = {}): ReportRow {
	return {
		id: "entry-1",
		workDate: "2026-03-02",
		timezone: "UTC",
		projectId: PROJECT_ID,
		projectName: "Example project",
		billingModel: "TIME_AND_MATERIALS",
		userId: "user-1",
		userName: "Ada Example",
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

function stubReport(rows: ReportRow[]) {
	mocks.loadTimeReport.mockResolvedValue({
		status: "ok",
		report: summarizeTimeReport(rows),
	});
}

const RANGE = { from: "2026-03-01", to: "2026-03-31" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadTimeTrackingProject.mockResolvedValue({
		id: PROJECT_ID,
		name: "Example project",
		organizationId: ORG_ID,
		deletedAt: null,
		status: "ACTIVE",
		billingModel: "TIME_AND_MATERIALS",
		timeRequireStartStop: false,
		timeDefaultBillable: null,
		organization: {
			timeRequireStartStop: false,
			timeDefaultBillable: null,
		},
	});
	stubReport([]);
});

describe("report input", () => {
	it.each([
		[projectTimeReportInputSchema, { projectId: PROJECT_ID }],
		[organizationTimeReportInputSchema, { organizationId: ORG_ID }],
	])("accepts up to 366 days and refuses more", (schema, scope) => {
		expect(
			schema.safeParse({ ...scope, from: "2028-01-01", to: "2028-12-31" })
				.success,
		).toBe(true);
		expect(
			schema.safeParse({ ...scope, from: "2026-01-01", to: "2027-01-02" })
				.success,
		).toBe(false);
	});

	it("refuses a range that ends before it starts", () => {
		expect(
			organizationTimeReportInputSchema.safeParse({
				organizationId: ORG_ID,
				from: "2026-03-31",
				to: "2026-03-01",
			}).success,
		).toBe(false);
	});

	it("refuses an empty id filter and an unknown billing model", () => {
		expect(
			organizationTimeReportInputSchema.safeParse({
				organizationId: ORG_ID,
				...RANGE,
				projectIds: [],
			}).success,
		).toBe(false);
		expect(
			organizationTimeReportInputSchema.safeParse({
				organizationId: ORG_ID,
				...RANGE,
				billingModel: "RETAINER",
			}).success,
		).toBe(false);
	});
});

describe("projectReport", () => {
	it.each([
		["projectReport", projectTimeReportProcedure],
		["exportProjectReportCsv", exportProjectTimeReportCsvProcedure],
	])(
		"%s is gated on seeing the project, then TIME_REPORT_VIEW",
		(_, procedure) => {
			expect(stub(procedure).__declared).toEqual([
				VISIBLE,
				{ kind: "project", permission: Permissions.TIME_REPORT_VIEW },
			]);
		},
	);

	it("reads only this project, in its organization, with the filters given", async () => {
		await call(projectTimeReportProcedure, projectTimeReportInputSchema, {
			projectId: PROJECT_ID,
			...RANGE,
			userIds: ["user-2"],
			billable: true,
			activity: "TESTING",
			billingModel: "FIXED_BID",
		});

		expect(mocks.loadTimeReport).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			from: "2026-03-01",
			to: "2026-03-31",
			projectIds: [PROJECT_ID],
			userIds: ["user-2"],
			billable: true,
			activity: "TESTING",
			billingModel: "FIXED_BID",
		});
	});

	it("filters by work item over any range within the cap, and exports the same filters", async () => {
		const input = {
			projectId: PROJECT_ID,
			from: "2026-02-10",
			to: "2026-03-17",
			storyIds: ["story-1"],
		};

		await call(
			projectTimeReportProcedure,
			projectTimeReportInputSchema,
			input,
		);
		await call(
			exportProjectTimeReportCsvProcedure,
			projectTimeReportInputSchema,
			input,
		);

		const expected = {
			organizationId: ORG_ID,
			from: "2026-02-10",
			to: "2026-03-17",
			projectIds: [PROJECT_ID],
			storyIds: ["story-1"],
		};
		expect(mocks.loadTimeReport).toHaveBeenNthCalledWith(1, expected);
		expect(mocks.loadTimeReport).toHaveBeenNthCalledWith(2, expected);
		expect(
			mocks.recordAuditFromRequest.mock.calls[0][1].metadata.filters,
		).toEqual({ storyIds: ["story-1"] });
	});

	it("refuses an empty work-item filter", () => {
		expect(
			projectTimeReportInputSchema.safeParse({
				projectId: PROJECT_ID,
				...RANGE,
				storyIds: [],
			}).success,
		).toBe(false);
	});

	it("is not found for a soft-deleted project", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue({
			id: PROJECT_ID,
			name: "Example project",
			organizationId: ORG_ID,
			deletedAt: new Date("2026-01-01T00:00:00Z"),
			status: "ACTIVE",
			billingModel: "FIXED_BID",
			timeRequireStartStop: false,
			timeDefaultBillable: null,
			organization: {
				timeRequireStartStop: false,
				timeDefaultBillable: null,
			},
		});

		await expect(
			call(projectTimeReportProcedure, projectTimeReportInputSchema, {
				projectId: PROJECT_ID,
				...RANGE,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.loadTimeReport).not.toHaveBeenCalled();
	});

	it("keeps the time of someone who has since left the project", async () => {
		stubReport([
			reportRow({ id: "a", userId: "user-1" }),
			reportRow({
				id: "b",
				userId: "user-gone",
				userName: "Former Member",
			}),
		]);

		const result = await call(
			projectTimeReportProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(
			result.rows.map((row: { userId: string }) => row.userId),
		).toEqual(["user-1", "user-gone"]);
		expect(result.totals.peopleCount).toBe(2);
	});

	it("returns totals that add up to its rows", async () => {
		stubReport([
			reportRow({ id: "a", durationMinutes: 90, billable: true }),
			reportRow({ id: "b", durationMinutes: 30, billable: false }),
		]);

		const result = await call(
			projectTimeReportProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(result.totals).toEqual({
			billableMinutes: 90,
			nonBillableMinutes: 30,
			totalMinutes: 120,
			peopleCount: 1,
		});
		expect(result.projects).toHaveLength(1);
		expect(result.projects[0].totalMinutes).toBe(120);
	});

	it("sends instants as ISO strings", async () => {
		stubReport([
			reportRow({
				startAt: new Date("2026-03-02T09:00:00.000Z"),
				stopAt: new Date("2026-03-02T10:00:00.000Z"),
			}),
		]);

		const result = await call(
			projectTimeReportProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(result.rows[0].startAt).toBe("2026-03-02T09:00:00.000Z");
		expect(result.rows[0].stopAt).toBe("2026-03-02T10:00:00.000Z");
	});

	it("refuses a report over the row cap with an explicit error", async () => {
		mocks.loadTimeReport.mockResolvedValue({
			status: "too_many_rows",
			limit: 20_000,
		});

		await expect(
			call(projectTimeReportProcedure, projectTimeReportInputSchema, {
				projectId: PROJECT_ID,
				...RANGE,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "TOO_MANY_ROWS", limit: 20_000 },
		});
	});
});

describe("organizationReport", () => {
	it.each([
		["organizationReport", organizationTimeReportProcedure],
		[
			"exportOrganizationReportCsv",
			exportOrganizationTimeReportCsvProcedure,
		],
	])(
		"%s is gated on TIME_REPORT_VIEW in the organization",
		(_, procedure) => {
			expect(stub(procedure).__declared).toEqual([
				{
					kind: "input-org",
					permission: Permissions.TIME_REPORT_VIEW,
					options: { requireOrganization: true },
				},
			]);
		},
	);

	it("reads the whole organization with the filters given", async () => {
		await call(
			organizationTimeReportProcedure,
			organizationTimeReportInputSchema,
			{
				organizationId: ORG_ID,
				...RANGE,
				projectIds: ["project-1", "project-2"],
				billable: false,
				billingModel: "TIME_AND_MATERIALS",
			},
		);

		expect(mocks.loadTimeReport).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			from: "2026-03-01",
			to: "2026-03-31",
			projectIds: ["project-1", "project-2"],
			userIds: undefined,
			billable: false,
			activity: undefined,
			billingModel: "TIME_AND_MATERIALS",
		});
	});

	it("leaves the billing model unfiltered when none is given", async () => {
		await call(
			organizationTimeReportProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(
			mocks.loadTimeReport.mock.calls[0][0].billingModel,
		).toBeUndefined();
	});

	it("refuses a report over the row cap with an explicit error", async () => {
		mocks.loadTimeReport.mockResolvedValue({
			status: "too_many_rows",
			limit: 20_000,
		});

		await expect(
			call(
				exportOrganizationTimeReportCsvProcedure,
				organizationTimeReportInputSchema,
				{ organizationId: ORG_ID, ...RANGE },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("CSV export", () => {
	function parseLines(csv: string): string[] {
		expect(csv.endsWith("\r\n")).toBe(true);
		return csv.slice(0, -2).split("\r\n");
	}

	it("writes the columns in order", async () => {
		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(TIME_REPORT_CSV_HEADER).toEqual([
			"work_date",
			"user",
			"project",
			"project_type",
			"work_item_reference",
			"work_item_title",
			"activity",
			"duration_minutes",
			"duration_hours",
			"billable",
			"description",
			"start_at",
			"stop_at",
			"timezone",
		]);
		expect(parseLines(csv)).toEqual([TIME_REPORT_CSV_HEADER.join(",")]);
	});

	it("writes one line per entry with stable values and offset start and stop times", async () => {
		stubReport([
			reportRow({
				workDate: "2026-03-02",
				projectName: "Example project",
				billingModel: "FIXED_BID",
				userName: "Ada Example",
				activity: "CODE_REVIEW",
				storyIdentifier: "F-12",
				storyTitle: "Sign-in page",
				description: "Reviewed the form",
				billable: false,
				durationMinutes: 90,
				timezone: "Europe/Berlin",
				startAt: new Date("2026-03-02T08:00:00.000Z"),
				stopAt: new Date("2026-03-02T09:30:00.000Z"),
			}),
		]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(parseLines(csv)[1]).toBe(
			"2026-03-02,Ada Example,Example project,Fixed bid,F-12,Sign-in page,Code review,90,1.50,non-billable,Reviewed the form,2026-03-02T09:00:00+01:00,2026-03-02T10:30:00+01:00,Europe/Berlin",
		);
	});

	it("writes the offset in force at each instant across a daylight-saving change", async () => {
		stubReport([
			reportRow({
				workDate: "2026-03-28",
				timezone: "Europe/Berlin",
				durationMinutes: 420,
				startAt: new Date("2026-03-28T22:00:00.000Z"),
				stopAt: new Date("2026-03-29T05:00:00.000Z"),
			}),
		]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		const cells = parseLines(csv)[1].split(",");
		expect(cells.slice(-3)).toEqual([
			"2026-03-28T23:00:00+01:00",
			"2026-03-29T07:00:00+02:00",
			"Europe/Berlin",
		]);
	});

	it("writes a zero offset as +00:00", async () => {
		stubReport([
			reportRow({
				timezone: "UTC",
				startAt: new Date("2026-03-02T08:00:00.000Z"),
				stopAt: new Date("2026-03-02T09:00:00.000Z"),
			}),
		]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(parseLines(csv)[1]).toContain(
			",2026-03-02T08:00:00+00:00,2026-03-02T09:00:00+00:00,UTC",
		);
	});

	it("leaves work item, description and every timed field empty when there are none", async () => {
		stubReport([reportRow({ durationMinutes: 45 })]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(parseLines(csv)[1]).toBe(
			"2026-03-02,Ada Example,Example project,Time and materials,,,Development,45,0.75,billable,,,,",
		);
	});

	it("escapes quotes, commas and newlines", async () => {
		stubReport([
			reportRow({
				projectName: "Alpha, Beta",
				description: 'Said "done"\nthen left',
			}),
		]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(csv).toContain('"Alpha, Beta"');
		expect(csv).toContain('"Said ""done""\nthen left"');
	});

	it.each([
		["=", "=SUM(A1)"],
		["+", "+1"],
		["-", "-1"],
		["@", "@cmd"],
		["tab", "\tcmd"],
		["carriage return", "\rcmd"],
	])("neutralises a description starting with %s", async (_, description) => {
		stubReport([reportRow({ description })]);

		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(csv).toContain(`'${description}`);
		expect(csv).not.toContain(`,${description}`);
	});

	it("has exactly the report's rows and no total line, so it reconciles with the screen", async () => {
		const rows = [
			reportRow({ id: "a", durationMinutes: 90 }),
			reportRow({ id: "b", durationMinutes: 30, billable: false }),
			reportRow({
				id: "c",
				projectId: "project-2",
				projectName: "Second project",
				durationMinutes: 15,
			}),
		];
		stubReport(rows);
		const input = { organizationId: ORG_ID, ...RANGE };

		const report = await call(
			organizationTimeReportProcedure,
			organizationTimeReportInputSchema,
			input,
		);
		const { csv } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			input,
		);

		const dataLines = parseLines(csv).slice(1);
		expect(dataLines).toHaveLength(report.rows.length);
		const csvMinutes = dataLines
			.map((line) => Number(line.split(",")[7]))
			.reduce((sum, minutes) => sum + minutes, 0);
		expect(csvMinutes).toBe(report.totals.totalMinutes);
		const csvBillableMinutes = dataLines
			.filter((line) => line.split(",")[9] === "billable")
			.map((line) => Number(line.split(",")[7]))
			.reduce((sum, minutes) => sum + minutes, 0);
		expect(csvBillableMinutes).toBe(report.totals.billableMinutes);
	});

	it("names the file after the project and range", async () => {
		const { filename } = await call(
			exportProjectTimeReportCsvProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(filename).toBe(
			"time-example-project-2026-03-01-to-2026-03-31.csv",
		);
	});

	it("names the organization file after the range", async () => {
		const { filename } = await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(filename).toBe("time-2026-03-01-to-2026-03-31.csv");
	});
});

describe("a deleted account's time", () => {
	// The query layer names such a row by the name saved with the entry; the
	// screen and the CSV both pass that name through.
	const deletedAuthorRow = () =>
		reportRow({ id: "gone", userId: null, userName: "Former Member" });

	it("stays in the report under the saved name, with no id", async () => {
		stubReport([deletedAuthorRow()]);

		const result = await call(
			projectTimeReportProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(result.rows[0]).toMatchObject({
			userId: null,
			userName: "Former Member",
		});
		expect(result.totals.totalMinutes).toBe(60);
	});

	it("stays in the CSV under the saved name", async () => {
		stubReport([deletedAuthorRow()]);

		const { csv } = await call(
			exportProjectTimeReportCsvProcedure,
			projectTimeReportInputSchema,
			{ projectId: PROJECT_ID, ...RANGE },
		);

		expect(csv.split("\r\n")[1].split(",")[1]).toBe("Former Member");
	});
});

describe("export audit", () => {
	it("records one row for a project export, with what was asked and no entry contents", async () => {
		stubReport([
			reportRow({ id: "a", description: "Private note" }),
			reportRow({ id: "b" }),
		]);

		await call(
			exportProjectTimeReportCsvProcedure,
			projectTimeReportInputSchema,
			{
				projectId: PROJECT_ID,
				...RANGE,
				userIds: ["user-1"],
				billable: true,
			},
		);

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [auditContext, row] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(auditContext).toBe(context);
		expect(row).toMatchObject({
			action: "time.report_exported",
			category: "audit",
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
			outcome: "success",
		});
		expect(row.metadata).toEqual({
			scope: "project",
			projectId: PROJECT_ID,
			from: "2026-03-01",
			to: "2026-03-31",
			filters: { userIds: ["user-1"], billable: true },
			rowCount: 2,
		});
		expect(JSON.stringify(row)).not.toContain("Private note");
	});

	it("records one row for an organization export", async () => {
		stubReport([reportRow()]);

		await call(
			exportOrganizationTimeReportCsvProcedure,
			organizationTimeReportInputSchema,
			{
				organizationId: ORG_ID,
				...RANGE,
				projectIds: ["project-1"],
				billingModel: "TIME_AND_MATERIALS",
			},
		);

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const row = mocks.recordAuditFromRequest.mock.calls[0][1];
		expect(row).toMatchObject({
			action: "time.report_exported",
			organizationId: ORG_ID,
			projectId: null,
		});
		expect(row.metadata).toEqual({
			scope: "organization",
			from: "2026-03-01",
			to: "2026-03-31",
			filters: {
				projectIds: ["project-1"],
				billingModel: "TIME_AND_MATERIALS",
			},
			rowCount: 1,
		});
	});

	it("records nothing when a report is read on screen", async () => {
		stubReport([reportRow()]);

		await call(projectTimeReportProcedure, projectTimeReportInputSchema, {
			projectId: PROJECT_ID,
			...RANGE,
		});
		await call(
			organizationTimeReportProcedure,
			organizationTimeReportInputSchema,
			{ organizationId: ORG_ID, ...RANGE },
		);

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("records nothing when an export is refused", async () => {
		mocks.loadTimeReport.mockResolvedValue({
			status: "too_many_rows",
			limit: 20_000,
		});

		await expect(
			call(
				exportOrganizationTimeReportCsvProcedure,
				organizationTimeReportInputSchema,
				{ organizationId: ORG_ID, ...RANGE },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
