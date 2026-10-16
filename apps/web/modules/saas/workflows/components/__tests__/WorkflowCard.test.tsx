import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		basePath: "/app/org-example",
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		workflows: {
			delete: { mutationOptions: () => ({}) },
			duplicate: { mutationOptions: () => ({}) },
			update: { mutationOptions: () => ({}) },
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn() }),
}));

import { WorkflowCard } from "../WorkflowCard";

function workflow(triggerType: string) {
	return {
		id: "wf-1",
		name: "Weekly work items",
		description: null,
		status: "PUBLISHED" as const,
		triggerType,
		version: 3,
		updatedAt: new Date("2026-10-14T09:00:00Z"),
		_count: { executions: 4, versions: 3 },
	};
}

describe("WorkflowCard — the Scheduled badge", () => {
	it("marks a scheduled workflow in the grid, instead of naming its trigger twice", () => {
		render(<WorkflowCard workflow={workflow("SCHEDULE")} />);

		expect(screen.getByText("scheduled")).toBeInTheDocument();
		expect(screen.queryByText("Schedule")).not.toBeInTheDocument();
	});

	it("explains the badge to someone who hovers it", () => {
		render(<WorkflowCard workflow={workflow("SCHEDULE")} />);

		expect(screen.getByTitle("scheduledTitle")).toBeInTheDocument();
	});

	it("keeps naming the trigger of a workflow that is not scheduled", () => {
		render(<WorkflowCard workflow={workflow("MANUAL")} />);

		expect(screen.getByText("Manual")).toBeInTheDocument();
		expect(screen.queryByText("scheduled")).not.toBeInTheDocument();
	});

	it("marks a scheduled workflow in the list too", () => {
		render(<WorkflowCard workflow={workflow("SCHEDULE")} variant="list" />);

		expect(screen.getByText("scheduled")).toBeInTheDocument();
	});

	it("leaves an unscheduled workflow unmarked in the list", () => {
		render(<WorkflowCard workflow={workflow("WEBHOOK")} variant="list" />);

		expect(screen.queryByText("scheduled")).not.toBeInTheDocument();
	});

	it("still shows the workflow's status beside the badge", () => {
		render(<WorkflowCard workflow={workflow("SCHEDULE")} />);

		expect(screen.getByText("Published")).toBeInTheDocument();
	});
});
