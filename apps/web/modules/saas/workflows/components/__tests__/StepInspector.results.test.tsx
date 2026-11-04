import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ViewedRun } from "../../lib/run-steps";
import type { WorkflowNode } from "../../lib/types";
import { StepInspector } from "../editor/StepInspector";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const labels: Record<string, string> = {
			stepOutput: "Step output",
			rawOutput: "Raw output",
			rawStepOutput: "Raw step output",
			draftConfiguration: "Current draft configuration",
		};
		return labels[key] ?? key;
	},
}));
vi.mock("../NodeConfigEditor", () => ({
	NodeConfigEditor: () => (
		<label>
			Draft prompt
			<textarea defaultValue="Current draft" />
		</label>
	),
}));
const node: WorkflowNode = {
	id: "ai-step",
	type: "ai-generate-text",
	position: { x: 0, y: 0 },
	data: { label: "Generate text", config: {} },
};
function view(output: unknown, error: string | null = null): ViewedRun {
	return {
		shortId: "run-1234",
		steps: new Map([
			[
				node.id,
				{
					status: error ? "FAILED" : "COMPLETED",
					duration: 250,
					output,
					error,
				},
			],
		]),
	};
}
const props = { node, onBack: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() };
describe("step execution results", () => {
	it("puts readable AI output first and keeps draft configuration collapsed", () => {
		render(
			<StepInspector
				{...props}
				viewedRun={view({ text: "FABRIC GENERATED VERIFIED" })}
			/>,
		);
		expect(screen.getByLabelText("Step output")).toHaveTextContent(
			"FABRIC GENERATED VERIFIED",
		);
		expect(
			screen.getByRole("textbox", { name: "Draft prompt" }),
		).not.toBeVisible();
		expect(
			screen.getByText("Current draft configuration").closest("details"),
		).not.toHaveAttribute("open");
		expect(
			screen.queryByRole("button", { name: "Delete step" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByText("Current draft configuration"));
		expect(
			screen.getByRole("textbox", { name: "Draft prompt" }),
		).toBeVisible();
	});
	it("keeps full raw output available without wrapping the answer in JSON", () => {
		render(
			<StepInspector
				{...props}
				viewedRun={view({ text: "A readable answer", tokens: 12 })}
			/>,
		);
		expect(screen.getByLabelText("Step output").textContent).toBe(
			"A readable answer",
		);
		fireEvent.click(screen.getByText("Raw output"));
		expect(screen.getByLabelText("Raw step output")).toHaveTextContent(
			'"tokens": 12',
		);
	});
	it("shows a failed step's error before collapsed configuration", () => {
		render(
			<StepInspector
				{...props}
				viewedRun={view(
					null,
					"AI request failed: No AI provider configured.",
				)}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"No AI provider configured",
		);
		expect(
			screen.getByText("Current draft configuration").closest("details"),
		).not.toHaveAttribute("open");
	});
	it("preserves editable configuration and deletion when back in editing mode", () => {
		render(<StepInspector {...props} viewedRun={null} />);
		expect(
			screen.getByRole("textbox", { name: "Draft prompt" }),
		).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
		expect(props.onDelete).toHaveBeenCalledWith(node.id);
	});
	it("shows structured outputs for non-text actions", () => {
		render(
			<StepInspector
				{...props}
				node={{ ...node, type: "http-request" }}
				viewedRun={view({ status: 200, data: { ok: true } })}
			/>,
		);
		expect(screen.getByLabelText("Step output")).toHaveTextContent(
			'"ok": true',
		);
	});
});
