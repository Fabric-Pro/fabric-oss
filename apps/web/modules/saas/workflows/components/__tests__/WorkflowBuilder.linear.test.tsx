import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
	ReactFlow: () => <div data-testid="react-flow" />,
	ReactFlowProvider: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	useNodesState: () => [[], vi.fn(), vi.fn()],
	useEdgesState: () => [[], vi.fn(), vi.fn()],
	useReactFlow: () => ({ screenToFlowPosition: vi.fn(), fitView: vi.fn() }),
	Background: () => null,
	Controls: () => null,
	MiniMap: () => null,
	addEdge: vi.fn(),
	BackgroundVariant: { Dots: "dots" },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/app/org-example",
}));

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { WorkflowBuilder } from "../WorkflowBuilder";

function renderBuilder(flags: Partial<Record<FeatureFlagKey, boolean>>) {
	return render(
		<FeatureFlagProvider value={flags as Record<FeatureFlagKey, boolean>}>
			<WorkflowBuilder />
		</FeatureFlagProvider>,
	);
}

describe("WorkflowBuilder — Linear action nodes visibility", () => {
	it("hides Linear nodes from the palette when LINEAR_INTEGRATION is false", () => {
		renderBuilder({ LINEAR_INTEGRATION: false });

		const addActionBtn = screen.getByTitle("Add action");
		fireEvent.click(addActionBtn);

		expect(screen.getByText("HTTP Request")).toBeInTheDocument();
		expect(
			screen.queryByText("Create Linear Ticket"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Find Linear Issues"),
		).not.toBeInTheDocument();
	});

	it("shows Linear nodes in the palette when LINEAR_INTEGRATION is true", async () => {
		renderBuilder({ LINEAR_INTEGRATION: true });

		const addActionBtn = screen.getByTitle("Add action");
		fireEvent.click(addActionBtn);

		await screen.findByText("Create Linear Ticket");
		expect(screen.getByText("Find Linear Issues")).toBeInTheDocument();
	});
});
