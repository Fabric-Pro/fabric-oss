import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The canvas itself is out of scope here: the graph comes straight from the
// props, so the inspector is what is under test.
vi.mock("@xyflow/react", () => ({
	ReactFlow: () => <div data-testid="react-flow" />,
	ReactFlowProvider: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	useNodesState: (initial: unknown[]) => [initial, vi.fn(), vi.fn()],
	useEdgesState: (initial: unknown[]) => [initial, vi.fn(), vi.fn()],
	useReactFlow: () => ({ screenToFlowPosition: vi.fn(), fitView: vi.fn() }),
	Background: () => null,
	addEdge: vi.fn(),
	BackgroundVariant: { Dots: "dots" },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/app/org-example",
}));

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import type { WorkflowEdge, WorkflowNode } from "../../lib/types";
import { WorkflowBuilder } from "../WorkflowBuilder";

const nodes: WorkflowNode[] = [
	{
		id: "fetch",
		type: "http-request",
		position: { x: 0, y: 132 },
		data: { label: "Fetch report", config: { method: "GET" } },
	},
	{
		id: "start",
		type: "trigger",
		position: { x: 0, y: 0 },
		data: { label: "Every morning", config: { triggerType: "schedule" } },
	},
];
const edges: WorkflowEdge[] = [
	{ id: "start->fetch", source: "start", target: "fetch" },
];

function renderBuilder() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<FeatureFlagProvider value={{} as Record<FeatureFlagKey, boolean>}>
				<WorkflowBuilder
					initialNodes={nodes}
					initialEdges={edges}
					workflowId="wf-example"
					workflowName="Morning report"
				/>
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

const inspector = () =>
	screen.getByRole("complementary", { name: "Inspector" });

describe("WorkflowBuilder — inspector", () => {
	it("opens on the workflow overview, with the steps numbered in flow order", () => {
		renderBuilder();

		expect(screen.getByRole("tab", { name: "Workflow" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		const steps = within(
			within(inspector()).getByRole("region", { name: "Steps" }),
		).getAllByRole("button");
		expect(steps.map((step) => step.textContent)).toEqual([
			expect.stringContaining("Every morning"),
			expect.stringContaining("Fetch report"),
		]);
		expect(within(inspector()).getByText("Schedule")).toBeInTheDocument();
	});

	it("switches between the overview and the Add step palette", () => {
		renderBuilder();

		fireEvent.click(screen.getByRole("tab", { name: "Add step" }));

		expect(screen.getByRole("tab", { name: "Add step" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByLabelText("Search actions")).toBeInTheDocument();
		expect(screen.getByText("Manage integrations")).toHaveAttribute(
			"href",
			"/app/org-example",
		);

		fireEvent.click(screen.getByRole("tab", { name: "Workflow" }));

		expect(
			screen.queryByLabelText("Search actions"),
		).not.toBeInTheDocument();
		expect(
			within(inspector()).getByRole("region", { name: "Steps" }),
		).toBeInTheDocument();
	});

	it("shows a step picked from the list, labels the tab Step, and goes back to the overview", () => {
		renderBuilder();

		fireEvent.click(
			within(inspector()).getByRole("button", { name: /Fetch report/ }),
		);

		expect(screen.getByRole("tab", { name: "Step" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByLabelText("Label")).toHaveValue("Fetch report");
		expect(
			screen.getByRole("button", { name: "Delete step" }),
		).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: "Back to workflow" }),
		);

		expect(
			screen.getByRole("tab", { name: "Workflow" }),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Label")).not.toBeInTheDocument();
	});

	it("moves between tabs with the arrow keys", () => {
		renderBuilder();

		fireEvent.keyDown(screen.getByRole("tab", { name: "Workflow" }), {
			key: "ArrowRight",
		});

		expect(screen.getByRole("tab", { name: "Add step" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});
});
