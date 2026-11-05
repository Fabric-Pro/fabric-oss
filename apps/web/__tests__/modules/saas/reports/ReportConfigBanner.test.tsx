import { ReportConfigBanner } from "@saas/reports/components/ReportConfigBanner";
import type { ReportReadiness } from "@saas/reports/lib/report-readiness";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function readiness(connection: ReportReadiness["connection"]): ReportReadiness {
	return {
		connection,
		connectionLabel: "",
		connectionTone: "warning",
		connectionTested: true,
		missingRequiredParams: ["team"],
		missingProjects: [],
		recovery: { needsReconnect: false, needsProjectSelect: false },
		checks: [],
		fails: 0,
		warns: 0,
		hardBlocked: true,
		verdict: { tone: "warning", title: "", subtitle: "" },
	};
}

function show(connection: ReportReadiness["connection"], readOnly?: boolean) {
	render(
		<ReportConfigBanner
			readiness={readiness(connection)}
			onTest={vi.fn()}
			onScrollToConnection={vi.fn()}
			onScrollToParams={vi.fn()}
			reconnectHref="/app/example-org/mcp-servers"
			readOnly={readOnly}
		/>,
	);
}

describe("ReportConfigBanner", () => {
	it("gives someone who may edit the report the fixes", () => {
		show("auth_expired");

		expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Fill in" })).toBeTruthy();
	});

	it.each([
		"auth_expired",
		"error",
		"unreachable",
		"not_configured",
	] as const)(
		"tells someone who only reads the report of a %s connection, with nothing to press but dismiss",
		(connection) => {
			show(connection, true);

			expect(
				screen.getByText("This report’s data source needs attention"),
			).toBeTruthy();
			expect(
				screen.getByText("This report is missing required parameters"),
			).toBeTruthy();
			expect(screen.queryByRole("link")).toBeNull();
			for (const button of screen.getAllByRole("button")) {
				expect(button.getAttribute("aria-label")).toBe("Dismiss");
			}
		},
	);
});
