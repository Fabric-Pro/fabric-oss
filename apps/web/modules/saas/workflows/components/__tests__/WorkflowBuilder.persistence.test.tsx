import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowNode, WorkflowEdge } from "../../lib/types";
vi.mock("@xyflow/react", () => ({
	ReactFlow: ({
		nodes,
		edges,
		onNodeClick,
	}: {
		nodes: WorkflowNode[];
		edges: WorkflowEdge[];
		onNodeClick: (e: unknown, n: WorkflowNode) => void;
	}) => (
		<div data-testid="graph" data-edges={JSON.stringify(edges)}>
			{nodes.map((n) => (
				<button
					type="button"
					key={n.id}
					onClick={() => onNodeClick(null, n)}
				>
					{n.data.label || n.id}
				</button>
			))}
		</div>
	),
	ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
	useNodesState: (initial: WorkflowNode[]) => [...useState(initial), vi.fn()],
	useEdgesState: (initial: WorkflowEdge[]) => [...useState(initial), vi.fn()],
	useReactFlow: () => ({ screenToFlowPosition: vi.fn(), fitView: vi.fn() }),
	Background: () => null,
	BackgroundVariant: { Dots: "dots" },
	addEdge: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: () => "/app/example-org/workflows",
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("../PublishDialog", () => ({
	PublishDialog: ({ open }: { open: boolean }) =>
		open ? <div>Publish saved version</div> : null,
}));
vi.mock("../VersionHistoryPanel", () => ({ VersionHistoryPanel: () => null }));
vi.mock("../editor/AskAiBar", () => ({ AskAiBar: () => null }));
vi.mock("../editor/CanvasControls", () => ({
	CanvasControls: () => null,
	AddStepAnchor: () => null,
	FIT_VIEW_OPTIONS: {},
}));
vi.mock("../editor/StepInspector", () => ({
	StepInspector: ({
		node,
		onUpdate,
	}: {
		node: WorkflowNode;
		onUpdate: (id: string, data: unknown) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onUpdate(node.id, {
					label: "Edited step",
					config: { integrationId: "connection-example" },
				})
			}
		>
			Edit selected step
		</button>
	),
}));
import { WorkflowBuilder } from "../WorkflowBuilder";
const nodes: WorkflowNode[] = [
	{
		id: "start",
		type: "trigger",
		data: { label: "Start", config: { triggerType: "manual" } },
		position: { x: 0, y: 0 },
	},
	{
		id: "end",
		type: "http-request",
		data: { label: "Fetch", config: { url: "https://example.com" } },
		position: { x: 0, y: 132 },
	},
];
const edges = [{ id: "e1", source: "start", target: "end" }];
const props = {
	workflowId: "workflow-example",
	organizationId: "org-example",
	initialNodes: nodes,
	initialEdges: edges,
};
function edit() {
	fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
	fireEvent.click(screen.getByRole("button", { name: "Edit selected step" }));
}
describe("workflow graph persistence", () => {
	it("waits for acknowledged save before opening publish", async () => {
		let resolve: () => void = () => {};
		const save = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolve = r;
				}),
		);
		render(<WorkflowBuilder {...props} onSave={save} />);
		edit();
		fireEvent.click(screen.getByRole("button", { name: "Publish v2" }));
		expect(save).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					id: "end",
					data: expect.objectContaining({
						label: "Edited step",
						config: { integrationId: "connection-example" },
					}),
				}),
			]),
			edges,
		);
		expect(
			screen.queryByText("Publish saved version"),
		).not.toBeInTheDocument();
		await act(async () => resolve());
		expect(screen.getByText("Publish saved version")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Saved draft");
	});
	it("keeps edits dirty and publishing closed if save fails", async () => {
		render(
			<WorkflowBuilder
				{...props}
				onSave={vi.fn().mockRejectedValue(new Error("Unavailable"))}
			/>,
		);
		edit();
		fireEvent.click(screen.getByRole("button", { name: "Publish v2" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Publish v2" }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByText("Publish saved version"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
	});
	it("remounts nodes, edges, selection and undo state when switching to an empty workflow", () => {
		const view = render(<WorkflowBuilder {...props} />);
		edit();
		view.rerender(
			<WorkflowBuilder
				{...props}
				workflowId="empty-example"
				initialNodes={[]}
				initialEdges={[]}
			/>,
		);
		expect(screen.getByTestId("graph")).toHaveAttribute("data-edges", "[]");
		expect(screen.queryByText("Edited step")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Edit selected step" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent("Saved draft");
	});
	it("does not overwrite dirty changes on background refetch", () => {
		const view = render(<WorkflowBuilder {...props} />);
		edit();
		view.rerender(
			<WorkflowBuilder
				{...props}
				initialNodes={nodes.map((n) => ({
					...n,
					data: { ...n.data, label: "Server changed" },
				}))}
				initialEdges={[]}
			/>,
		);
		expect(screen.getByText("Edited step")).toBeInTheDocument();
		expect(screen.getByTestId("graph")).toHaveAttribute(
			"data-edges",
			JSON.stringify(edges),
		);
		expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
	});
	it("does not replay a dirty refetch after the following save succeeds", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const view = render(<WorkflowBuilder {...props} onSave={save} />);
		edit();
		view.rerender(
			<WorkflowBuilder
				{...props}
				onSave={save}
				initialNodes={nodes.map((n) => ({
					...n,
					data: { ...n.data, label: "Stale server graph" },
				}))}
				initialEdges={[]}
			/>,
		);
		fireEvent.click(screen.getByTestId("workflow-save"));
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("Saved draft"),
		);
		expect(screen.getByText("Edited step")).toBeInTheDocument();
		expect(screen.getByTestId("graph")).toHaveAttribute(
			"data-edges",
			JSON.stringify(edges),
		);
		expect(
			screen.queryByText("Stale server graph"),
		).not.toBeInTheDocument();
	});
	it("reloads the entire clean graph including deleted edges and an empty graph", async () => {
		const view = render(<WorkflowBuilder {...props} />);
		view.rerender(
			<WorkflowBuilder {...props} initialNodes={[]} initialEdges={[]} />,
		);
		await waitFor(() =>
			expect(screen.getByTestId("graph")).toHaveAttribute(
				"data-edges",
				"[]",
			),
		);
		expect(
			screen.queryByRole("button", { name: "Fetch" }),
		).not.toBeInTheDocument();
	});
	it("saves an empty graph after all steps have been removed", async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		render(
			<WorkflowBuilder
				{...props}
				initialNodes={[]}
				initialEdges={[]}
				onSave={save}
			/>,
		);
		fireEvent.click(screen.getByTestId("workflow-save"));
		await waitFor(() => expect(save).toHaveBeenCalledWith([], []));
	});
});
