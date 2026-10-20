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

describe("WorkflowCard — the grid header", () => {
	const LONG_NAME = "Ledger reconciliation weekly feature status page";

	it("gives the title row only the icon, the title and the menu, so a long title keeps the card's width", () => {
		render(
			<WorkflowCard
				workflow={{ ...workflow("SCHEDULE"), name: LONG_NAME }}
			/>,
		);

		const header = screen.getByTestId("workflow-card-header");
		const title = screen.getByRole("heading", { name: LONG_NAME });
		const menu = screen.getByRole("button", { name: "Workflow actions" });

		expect(header.children).toHaveLength(3);
		expect(header.children[1]).toContainElement(title);
		expect(header.children[2]).toContainElement(menu);
		expect(header).not.toContainElement(screen.getByText("Published"));
	});

	it("shows the status in the meta row, in the flow rather than floated over the title", () => {
		const { container } = render(
			<WorkflowCard
				workflow={{ ...workflow("SCHEDULE"), name: LONG_NAME }}
			/>,
		);

		const status = screen.getByText("Published");
		expect(screen.getByTestId("workflow-card-meta")).toContainElement(
			status,
		);
		for (
			let node: HTMLElement | null = status;
			node && node !== container;
			node = node.parentElement
		) {
			expect(node.className).not.toMatch(/\b(absolute|fixed)\b/);
		}
	});
});

describe("WorkflowCard — accessible controls", () => {
	it("links a list row's summary to its workflow and keeps its menu outside the link", () => {
		const { container } = render(
			<WorkflowCard workflow={workflow("SCHEDULE")} variant="list" />,
		);
		const link = screen.getByRole("link", { name: /Weekly work items/ });
		const menu = screen.getByRole("button", { name: "Workflow actions" });

		expect(link).toHaveAttribute("href", "/app/org-example/workflows/wf-1");
		expect(link).not.toContainElement(menu);
		expect(container.querySelector("button button, a button")).toBeNull();
	});

	it("names the grid icon's navigation action", () => {
		render(<WorkflowCard workflow={workflow("MANUAL")} />);

		expect(
			screen.getByRole("button", { name: "Open Weekly work items" }),
		).toBeInTheDocument();
	});
});

describe("WorkflowCard — the footer time", () => {
	it("reads as the last run once the workflow has run", () => {
		render(
			<WorkflowCard
				workflow={{
					...workflow("MANUAL"),
					lastRunAt: new Date("2026-01-15T09:00:00Z"),
				}}
			/>,
		);

		expect(screen.getByText(/^Last run .+ ago$/)).toBeInTheDocument();
		expect(screen.queryByText(/^Edited /)).not.toBeInTheDocument();
	});

	it("reads as the last edit for a workflow that has never run", () => {
		render(
			<WorkflowCard
				workflow={{ ...workflow("MANUAL"), lastRunAt: null }}
			/>,
		);

		expect(screen.getByText(/^Edited .+ ago$/)).toBeInTheDocument();
		expect(screen.queryByText(/^Last run /)).not.toBeInTheDocument();
	});
});
