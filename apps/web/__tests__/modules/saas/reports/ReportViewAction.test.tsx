import {
	NO_SUCCESSFUL_REPORT_MESSAGE,
	ReportViewAction,
	viewLatestReportHref,
} from "@saas/reports/components/ReportViewAction";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const REPORT = "/app/example-org/report-templates/instances/example-report";

describe("ReportViewAction", () => {
	it("links to the report page opened on its latest successful report", () => {
		render(
			<ReportViewAction
				hasSuccessfulReport
				href={viewLatestReportHref(REPORT)}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "View latest successful report" }),
		).toHaveAttribute("href", `${REPORT}?tab=history&view=latest`);
		expect(screen.queryByText(NO_SUCCESSFUL_REPORT_MESSAGE)).toBeNull();
	});

	it("opens the report in place when given an action", () => {
		const onView = vi.fn();
		render(<ReportViewAction hasSuccessfulReport onView={onView} />);

		fireEvent.click(
			screen.getByRole("button", {
				name: "View latest successful report",
			}),
		);

		expect(onView).toHaveBeenCalledTimes(1);
	});

	it("stays visible but disabled before a run succeeds, and says why in text", () => {
		render(
			<ReportViewAction
				hasSuccessfulReport={false}
				href={viewLatestReportHref(REPORT)}
			/>,
		);

		const view = screen.getByRole("button", { name: "View" });
		expect(view).toBeDisabled();
		expect(view).toHaveAccessibleDescription(NO_SUCCESSFUL_REPORT_MESSAGE);
		expect(screen.getByText(NO_SUCCESSFUL_REPORT_MESSAGE)).toBeVisible();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
