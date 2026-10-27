import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowConfirmationView } from "../../../hooks/useWorkflowConfirmation";
import { WorkflowConfirmationCard } from "../WorkflowConfirmationCard";

const confirmation: WorkflowConfirmationView = {
	workflowId: "workflow-1",
	workflowName: "Example workflow",
	messageId: "message-1",
	message: "Start this workflow?",
	status: "requested",
};

describe("WorkflowConfirmationCard", () => {
	it("provides named actions and a live status", () => {
		const onConfirm = vi.fn();
		const onDecline = vi.fn();
		render(
			<WorkflowConfirmationCard
				confirmation={confirmation}
				disabled={false}
				onConfirm={onConfirm}
				onDecline={onDecline}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Start this workflow?",
		);
		fireEvent.click(screen.getByRole("button", { name: "Execute" }));
		fireEvent.click(screen.getByRole("button", { name: "Decline" }));
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onDecline).toHaveBeenCalledOnce();
	});
	it.each([
		"submitting",
		"started",
		"declined",
		"unconfirmed",
		"failed",
	] as const)("removes executable actions for %s", (status) => {
		render(
			<WorkflowConfirmationCard
				confirmation={{ ...confirmation, status }}
				disabled={false}
				onConfirm={vi.fn()}
				onDecline={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
	});
	it("disables actions while another operation is active", () => {
		render(
			<WorkflowConfirmationCard
				confirmation={confirmation}
				disabled
				onConfirm={vi.fn()}
				onDecline={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
	});
});
