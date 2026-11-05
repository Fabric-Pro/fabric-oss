import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { NameSaveStatus } from "../editor/NameSaveFeedback";
import { WorkflowOverview } from "../editor/WorkflowOverview";

const props = {
	workflowId: "example-workflow",
	status: "DRAFT" as const,
	version: 1,
	triggerLabel: "Manual",
	steps: [],
	onSelectStep: vi.fn(),
};
it("announces saving, keeps a failed name for retry, and announces the persisted name", async () => {
	const save = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(undefined);
	function Harness() {
		const [name, setName] = useState("Original");
		const [status, setStatus] = useState<NameSaveStatus>("idle");
		return (
			<WorkflowOverview
				{...props}
				workflowName={name}
				nameSaveStatus={status}
				onRename={async (next) => {
					setStatus("saving");
					try {
						await save(next);
						setName(next);
						setStatus("saved");
					} catch (e) {
						setStatus("error");
						throw e;
					}
				}}
			/>
		);
	}
	render(<Harness />);
	const input = screen.getByLabelText("Name");
	fireEvent.change(input, { target: { value: "Retained draft" } });
	fireEvent.blur(input);
	await screen.findByText(/Name was not saved/);
	expect(input).toHaveValue("Retained draft");
	fireEvent.blur(input);
	await screen.findByText("Name saved");
	expect(save).toHaveBeenCalledTimes(2);
	expect(input).toHaveValue("Retained draft");
});
it("prevents editing while a name save is pending", () => {
	render(
		<WorkflowOverview
			{...props}
			workflowName="Example"
			nameSaveStatus="saving"
			onRename={vi.fn()}
		/>,
	);
	expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
	expect(screen.getByText("Saving name…")).toHaveAttribute(
		"aria-live",
		"polite",
	);
});

it("restores the retained failed name when overview is reopened", () => {
	render(
		<WorkflowOverview
			{...props}
			workflowName="Saved name"
			nameRetryValue="Failed unsaved name"
			nameSaveStatus="error"
			onRename={vi.fn()}
		/>,
	);
	expect(screen.getByLabelText("Name")).toHaveValue("Failed unsaved name");
});
