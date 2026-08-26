import type { ReportReadiness } from "@saas/reports/lib/report-readiness";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The rail renders CancelExecutionButton, which calls useMutation at render —
// stub the data-fetching layer so the rail renders without a real client.
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			instances: {
				cancelExecution: { mutationOptions: (o: unknown) => o },
			},
		},
	},
}));

import { ReportReadinessRail } from "../ReportReadinessRail";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

const readiness: ReportReadiness = {
	connection: "connected",
	connectionLabel: "Connected",
	connectionTone: "success",
	connectionTested: true,
	missingRequiredParams: [],
	missingProjects: [],
	recovery: { needsReconnect: false, needsProjectSelect: false },
	checks: [],
	fails: 0,
	warns: 0,
	hardBlocked: false,
	verdict: { tone: "success", title: "Ready", subtitle: "All set" },
};

const baseProps = {
	readiness,
	onGenerate: vi.fn(),
	isGenerating: false,
	onTest: vi.fn(),
	isTesting: false,
	executionCount: 1,
	onViewHistory: vi.fn(),
	meta: {
		template: "Sprint report",
		dataSource: "GitHub",
		output: "MARKDOWN",
		skillsCount: 0,
	},
	onViewArtifact: vi.fn(),
	organizationId: null,
	viewerUserId: "u1",
	viewerIsOrgAdmin: false,
	onExecutionCancelled: vi.fn(),
};

const artifactButton = () =>
	screen.queryByRole("button", { name: /report\.md/i });

describe("ReportReadinessRail — artifact suppression for CANCELLED (R10)", () => {
	it("does NOT surface the View-artifact affordance for a CANCELLED run, even if an artifact raced into existence", () => {
		render(
			<ReportReadinessRail
				{...baseProps}
				latestExecution={{
					id: "e1",
					status: "CANCELLED",
					userId: "u1",
					startedAt: new Date("2026-01-01T00:00:00Z"),
					duration: 1000,
					artifacts: [{ id: "a1", name: "report.md" }],
				}}
			/>,
		);

		expect(artifactButton()).not.toBeInTheDocument();
		// The run still reads as Cancelled in the Latest-run glance.
		expect(screen.getByText("Cancelled")).toBeInTheDocument();
	});

	it("DOES surface the View-artifact affordance for a COMPLETED run", () => {
		render(
			<ReportReadinessRail
				{...baseProps}
				latestExecution={{
					id: "e2",
					status: "COMPLETED",
					userId: "u1",
					startedAt: new Date("2026-01-01T00:00:00Z"),
					duration: 1000,
					artifacts: [{ id: "a2", name: "report.md" }],
				}}
			/>,
		);

		expect(artifactButton()).toBeInTheDocument();
	});
});
