/**
 * The organization's report list (Report Templates, My Instances): its
 * titles open Execution History and View opens the latest successful report,
 * as on a project's report cards.
 */
import { render, screen, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: () => "example-org",
}));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const node = (): unknown =>
		new Proxy(() => {}, {
			get: (_target, key) =>
				key === "queryOptions"
					? (options: { input: unknown }) => options
					: key === "mutationOptions"
						? () => ({})
						: node(),
		});
	return { orpc: node() };
});
vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: (previous: unknown) => previous,
	useQuery: () => ({
		data: {
			instances: [
				{
					id: "with-success",
					name: "Weekly status",
					templateId: "example-template",
					templateName: "Example template",
					isActive: true,
					executionCount: 2,
					latestExecutionStatus: "FAILED",
					latestSuccessfulReport: {
						executionId: "example-run",
						completedAt: "2026-11-01T00:00:00.000Z",
						artifactId: "example-artifact",
						artifactName: "report.md",
					},
				},
				{
					id: "never-succeeded",
					name: "Monthly summary",
					templateId: "example-template",
					templateName: "Example template",
					isActive: true,
					executionCount: 1,
					latestExecutionStatus: "FAILED",
					latestSuccessfulReport: null,
				},
			],
			total: 2,
		},
		isLoading: false,
		refetch: vi.fn(),
	}),
	useMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { NO_SUCCESSFUL_REPORT_MESSAGE } from "@saas/reports/components/ReportViewAction";
import { TemplateInstancesList } from "@saas/reports/components/TemplateInstancesList";

const BASE = "/app/example-org/report-templates";

function rowOf(name: string): HTMLElement {
	const row = screen.getByText(name).closest("tr");
	if (!row) {
		throw new Error(`no row for ${name}`);
	}
	return row;
}

function renderList() {
	render(
		<NuqsTestingAdapter>
			<TemplateInstancesList basePath={BASE} showTemplateColumn />
		</NuqsTestingAdapter>,
	);
}

describe("TemplateInstancesList", () => {
	it("links each title to the report's execution history", () => {
		renderList();

		expect(
			screen.getByRole("link", {
				name: /^Weekly status\s*, execution history$/,
			}),
		).toHaveAttribute("href", `${BASE}/instances/with-success?tab=history`);
		expect(
			screen.getByRole("link", {
				name: /^Monthly summary\s*, execution history$/,
			}),
		).toHaveAttribute(
			"href",
			`${BASE}/instances/never-succeeded?tab=history`,
		);
	});

	it("opens the latest successful report from View", () => {
		renderList();

		expect(
			within(rowOf("Weekly status")).getByRole("link", {
				name: "View latest successful report",
			}),
		).toHaveAttribute(
			"href",
			`${BASE}/instances/with-success?tab=history&view=latest`,
		);
	});

	it("keeps View visible but disabled, with the reason in text, before a run succeeds", () => {
		renderList();

		const row = rowOf("Monthly summary");
		expect(
			within(row).getByRole("button", { name: "View" }),
		).toBeDisabled();
		expect(
			within(row).getByText(NO_SUCCESSFUL_REPORT_MESSAGE),
		).toBeVisible();
		expect(
			within(row).queryByRole("link", {
				name: "View latest successful report",
			}),
		).toBeNull();
	});
});
