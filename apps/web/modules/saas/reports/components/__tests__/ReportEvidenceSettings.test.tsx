import { reportEvidenceConfigSchema } from "@repo/database/prisma/queries/lib/report-evidence";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { projects: { list: { queryOptions: (value: unknown) => value } } },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => m.query() }));

import { ReportEvidenceSettings } from "../ReportEvidenceSettings";

const config = reportEvidenceConfigSchema.parse({
	version: 1,
	period: "weekly",
	projectId: "project-1",
});
describe("shared report evidence settings", () => {
	it("keeps the existing report behavior until a period is deliberately selected", () => {
		m.query.mockReturnValue({
			data: undefined,
			isPending: false,
			isError: false,
		});
		const onChange = vi.fn();
		render(
			<ReportEvidenceSettings
				organizationId="org-1"
				onChange={onChange}
			/>,
		);
		expect(
			screen.queryByRole("combobox", { name: "Period to report on" }),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Set reporting period" }),
		);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				version: 1,
				period: "weekly",
				timezone: "UTC",
				partialData: "allow_with_notice",
				publication: "draft",
			}),
		);
	});
	it("labels period and timezone distinctly from cadence and explains the draft evidence boundary", () => {
		m.query.mockReturnValue({
			data: { projects: [] },
			isPending: false,
			isError: false,
		});
		render(
			<ReportEvidenceSettings
				value={config}
				organizationId="org-1"
				onChange={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("combobox", { name: "Period to report on" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Reporting timezone" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Changing the period leaves the run schedule unchanged/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Generated reports are drafts for review/),
		).toBeInTheDocument();
	});
	it("preserves an assigned project audience and never silently broadens it if project discovery fails", () => {
		m.query.mockReturnValue({
			data: undefined,
			isPending: false,
			isError: true,
		});
		render(
			<ReportEvidenceSettings
				value={config}
				lockedProjectId="project-1"
				organizationId="org-1"
				onChange={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Calendar, comparisons and audience",
			}),
		);
		expect(
			screen.getByRole("combobox", { name: "Report audience" }),
		).toBeDisabled();
		expect(
			screen.getByText(/Projects could not be loaded/),
		).toBeInTheDocument();
	});
	it("reveals fiscal controls only when a fiscal calendar is selected", () => {
		m.query.mockReturnValue({
			data: { projects: [] },
			isPending: false,
			isError: false,
		});
		render(
			<ReportEvidenceSettings
				value={{
					...config,
					calendar: "fiscal",
					fiscalYearStartMonth: 4,
				}}
				organizationId="org-1"
				onChange={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Calendar, comparisons and audience",
			}),
		);
		expect(
			screen.getByRole("combobox", { name: "Fiscal year starts in" }),
		).toHaveTextContent("April");
	});
});

it("labels project audiences as disconnected drafts rather than promising execution", () => {
	m.query.mockReturnValue({
		data: { projects: [{ id: "project-1", name: "Example project" }] },
		isPending: false,
		isError: false,
	});
	render(
		<ReportEvidenceSettings
			value={config}
			organizationId="org-1"
			onChange={vi.fn()}
		/>,
	);
	expect(screen.getByRole("status")).toHaveTextContent(
		"This draft cannot run or be scheduled",
	);
});

it("shows the usable Project knowledge path with a deliberate project choice", () => {
	m.query.mockReturnValue({
		data: { projects: [{ id: "project-1", name: "Example project" }] },
		isPending: false,
		isError: false,
	});
	render(
		<ReportEvidenceSettings
			value={config}
			organizationId="org-1"
			requireProject
			sourceDefinition={{
				dataSources: [
					{
						id: "knowledge",
						type: "fabric",
						provider: "fabric_project",
						operation: "project_knowledge",
					},
				],
			}}
			onChange={vi.fn()}
		/>,
	);
	expect(
		screen.getByRole("combobox", { name: "Report audience" }),
	).toHaveTextContent("Example project");
	expect(screen.getByRole("status")).toHaveTextContent(
		"Project knowledge is read using current project access",
	);
	expect(screen.getByRole("status")).not.toHaveTextContent("setup required");
});
