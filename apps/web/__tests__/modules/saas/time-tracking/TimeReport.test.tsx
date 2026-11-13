/**
 * The organization time report: one row per project with the grand total,
 * a row that opens onto its entries, the message for a month with too many
 * entries, and a CSV export that carries the filters on screen.
 */

import { ORPCError } from "@orpc/client";
import type {
	TimeReport as TimeReportData,
	TimeReportRow,
} from "@saas/time-tracking/lib/report-table";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockOrganizationReport,
	mockProjectReport,
	mockExportOrganization,
	mockTriggerDownload,
	procedure,
} = vi.hoisted(() => ({
	mockOrganizationReport: vi.fn(),
	mockProjectReport: vi.fn(),
	mockExportOrganization: vi.fn(),
	mockTriggerDownload: vi.fn(),
	/** A procedure's query utilities, keyed the way oRPC keys them. */
	procedure: (path: string, call: (input: unknown) => unknown) => ({
		key: () => [["timeTracking", path]],
		queryKey: ({ input }: { input: unknown }) => [
			["timeTracking", path],
			{ input, type: "query" },
		],
		call,
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		timeTracking: {
			organizationReport: procedure(
				"organizationReport",
				mockOrganizationReport,
			),
			projectReport: procedure("projectReport", mockProjectReport),
			exportOrganizationReportCsv: procedure(
				"exportOrganizationReportCsv",
				mockExportOrganization,
			),
			exportProjectReportCsv: procedure(
				"exportProjectReportCsv",
				vi.fn(),
			),
		},
		projects: {
			stories: {
				board: {
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["projects", "stories", "board"],
							{ input: options.input, type: "query" },
						],
						queryFn: async () => ({ statuses: [], stories: [] }),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/projects/lib/markdown-to-document", () => ({
	triggerBlobDownload: mockTriggerDownload,
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));

// November 2026 in the browser, so the month is fixed.
vi.mock("@saas/time-tracking/lib/zoned-time", () => ({
	browserTimeZone: () => "UTC",
	todayInZone: () => "2026-11-11",
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { TimeReport } from "@saas/time-tracking/components/TimeReport";

function row(overrides: Partial<TimeReportRow>): TimeReportRow {
	return {
		id: "entry-1",
		workDate: "2026-11-02",
		timezone: "UTC",
		projectId: "project-a",
		projectName: "Alpha",
		billingModel: "TIME_AND_MATERIALS",
		userId: "user-1",
		userName: "Member A",
		activity: "DEVELOPMENT",
		billable: true,
		durationMinutes: 120,
		description: "Invoice export",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startAt: null,
		stopAt: null,
		...overrides,
	};
}

const report: TimeReportData = {
	rows: [
		row({}),
		row({
			id: "entry-2",
			projectId: "project-b",
			projectName: "Beta",
			userId: "user-2",
			userName: "Member B",
			billable: false,
			durationMinutes: 30,
			description: null,
		}),
	],
	projects: [
		{
			projectId: "project-a",
			projectName: "Alpha",
			billingModel: "TIME_AND_MATERIALS",
			billableMinutes: 120,
			nonBillableMinutes: 0,
			totalMinutes: 120,
			peopleCount: 1,
		},
		{
			projectId: "project-b",
			projectName: "Beta",
			billingModel: "TIME_AND_MATERIALS",
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

function renderReport() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<TimeReport
				scope={{ kind: "organization", organizationId: "org-1" }}
			/>
		</QueryClientProvider>,
	);
}

function renderProjectReport() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<TimeReport
				scope={{
					kind: "project",
					projectId: "project-a",
					organizationId: "org-1",
				}}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockOrganizationReport.mockResolvedValue(report);
	mockProjectReport.mockResolvedValue(report);
	mockExportOrganization.mockResolvedValue({
		filename: "time-report-2026-11-01-to-2026-11-30.csv",
		csv: "Date,Project\n",
	});
});

describe("TimeReport", () => {
	it("shows one row per project and the organization total", async () => {
		renderReport();

		const table = await screen.findByRole("table");
		expect(
			within(table).getByRole("button", { name: "Alpha" }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole("button", { name: "Beta" }),
		).toBeInTheDocument();
		const totalRow = within(table).getByRole("rowheader", {
			name: "total",
		}).parentElement;
		expect(totalRow).toHaveTextContent("2h 30m");
		expect(screen.getByText("November 2026")).toBeInTheDocument();
	});

	it("opens on time-and-materials projects for the month", async () => {
		renderReport();

		await screen.findByRole("table");
		expect(mockOrganizationReport).toHaveBeenCalledWith({
			organizationId: "org-1",
			from: "2026-11-01",
			to: "2026-11-30",
			billingModel: "TIME_AND_MATERIALS",
		});
	});

	it("opens a project row onto its entries", async () => {
		renderReport();

		const alpha = await screen.findByRole("button", { name: "Alpha" });
		expect(alpha).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(/Invoice export/)).toBeNull();

		await userEvent.click(alpha);

		expect(alpha).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByText(/Member A · Development · Invoice export/),
		).toBeInTheDocument();
	});

	it("asks to narrow the filters when the month has too many entries", async () => {
		mockOrganizationReport.mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				data: { reason: "TOO_MANY_ROWS", limit: 20_000 },
			}),
		);
		renderReport();

		expect(await screen.findByText("tooManyRows")).toBeInTheDocument();
		expect(screen.queryByRole("table")).toBeNull();
		expect(
			screen.getByRole("button", { name: /exportCsv/ }),
		).toBeDisabled();
	});

	it("says so when the caller may not read the report", async () => {
		mockOrganizationReport.mockRejectedValue(new ORPCError("FORBIDDEN"));
		renderReport();

		expect(await screen.findByText("noAccess")).toBeInTheDocument();
	});

	it("exports the report with the filters on screen", async () => {
		renderReport();

		const exportButton = await screen.findByRole("button", {
			name: /exportCsv/,
		});
		await waitFor(() => expect(exportButton).toBeEnabled());
		await userEvent.click(exportButton);

		await waitFor(() =>
			expect(mockExportOrganization).toHaveBeenCalledWith({
				organizationId: "org-1",
				from: "2026-11-01",
				to: "2026-11-30",
				billingModel: "TIME_AND_MATERIALS",
			}),
		);
		await waitFor(() =>
			expect(mockTriggerDownload).toHaveBeenCalledWith(
				expect.any(Blob),
				"time-report-2026-11-01-to-2026-11-30.csv",
			),
		);
		const [blob] = mockTriggerDownload.mock.lastCall ?? [];
		const bytes = await new Promise<Uint8Array>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (reader.result && typeof reader.result !== "string") {
					resolve(new Uint8Array(reader.result));
				}
			};
			reader.readAsArrayBuffer(blob);
		});
		expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
	});

	it("exports every project once the project type default is cleared", async () => {
		renderReport();

		await screen.findByRole("table");
		await userEvent.click(screen.getByRole("button", { name: /^filter/ }));
		await userEvent.click(
			await screen.findByRole("button", { name: "clear" }),
		);

		const exportButton = screen.getByRole("button", { name: /exportCsv/ });
		await waitFor(() => expect(exportButton).toBeEnabled());
		await userEvent.click(exportButton);

		await waitFor(() =>
			expect(mockExportOrganization).toHaveBeenCalledWith({
				organizationId: "org-1",
				from: "2026-11-01",
				to: "2026-11-30",
			}),
		);
	});

	it("shows only the empty message for a month with no time", async () => {
		mockOrganizationReport.mockResolvedValue({
			rows: [],
			projects: [],
			totals: {
				billableMinutes: 0,
				nonBillableMinutes: 0,
				totalMinutes: 0,
				peopleCount: 0,
			},
		});
		renderReport();

		expect(await screen.findByText("empty")).toBeInTheDocument();
		expect(screen.queryByRole("table")).toBeNull();
		expect(
			screen.getByRole("button", { name: /exportCsv/ }),
		).toBeDisabled();
	});
});

describe("TimeReport for a project", () => {
	it("reads a custom range from the filters instead of the month", async () => {
		renderProjectReport();

		await screen.findByRole("table");
		expect(mockProjectReport).toHaveBeenCalledWith({
			projectId: "project-a",
			from: "2026-11-01",
			to: "2026-11-30",
		});

		await userEvent.click(screen.getByRole("button", { name: /^filter/ }));
		await userEvent.click(
			await screen.findByRole("button", { name: "periodCustom" }),
		);
		fireEvent.change(screen.getByLabelText("rangeFrom"), {
			target: { value: "2026-10-15" },
		});

		await waitFor(() =>
			expect(mockProjectReport).toHaveBeenCalledWith({
				projectId: "project-a",
				from: "2026-10-15",
				to: "2026-11-30",
			}),
		);
		expect(
			screen.queryByRole("button", { name: "previousMonth" }),
		).toBeNull();
	});

	it("keeps the last readable range while the dates are out of order", async () => {
		renderProjectReport();

		await screen.findByRole("table");
		await userEvent.click(screen.getByRole("button", { name: /^filter/ }));
		await userEvent.click(
			await screen.findByRole("button", { name: "periodCustom" }),
		);
		fireEvent.change(screen.getByLabelText("rangeTo"), {
			target: { value: "2026-10-01" },
		});

		expect(await screen.findByText("rangeInvalid")).toBeInTheDocument();
		expect(mockProjectReport).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: "2026-10-01" }),
		);
	});

	it("offers the project's work items as a filter", async () => {
		renderProjectReport();

		await screen.findByRole("table");
		await userEvent.click(screen.getByRole("button", { name: /^filter/ }));

		expect(
			await screen.findByRole("combobox", { name: "workItem" }),
		).toBeInTheDocument();
	});
});
