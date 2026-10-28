"use client";

import {
	Confirmation,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationDescription,
	ConfirmationIcon,
	ConfirmationRequest,
	ConfirmationTitle,
} from "../../../../../components/ai-elements/confirmation";
import type { WorkflowConfirmationView } from "../../hooks/useWorkflowConfirmation";

export function WorkflowConfirmationCard({
	confirmation,
	disabled,
	onConfirm,
	onDecline,
}: {
	confirmation: WorkflowConfirmationView;
	disabled: boolean;
	onConfirm: () => void;
	onDecline: () => void;
}) {
	const { status } = confirmation;
	const statusText = {
		requested: confirmation.message,
		submitting: "Starting workflow…",
		started:
			"Workflow started. Completion will be reported by the workflow execution.",
		unconfirmed:
			"The workflow may have started, but its start could not be confirmed. Check workflow executions before running it again.",
		failed: confirmation.message || "The workflow start was rejected.",
		declined: "Workflow execution declined.",
	}[status];
	return (
		<Confirmation
			approvalState={
				status === "declined" || status === "failed"
					? "rejected"
					: status === "requested"
						? "requested"
						: status === "started"
							? "accepted"
							: "pending"
			}
			className="mt-3"
		>
			<ConfirmationTitle>
				<ConfirmationIcon />
				Execute workflow: {confirmation.workflowName}
			</ConfirmationTitle>
			{confirmation.description && (
				<ConfirmationDescription>
					{confirmation.description}
				</ConfirmationDescription>
			)}
			<output
				aria-live="polite"
				className="text-sm text-muted-foreground"
			>
				{statusText}
			</output>
			{confirmation.executionId && (
				<p className="break-all text-xs text-muted-foreground">
					Execution: {confirmation.executionId}
				</p>
			)}
			<ConfirmationRequest>
				<ConfirmationActions>
					<ConfirmationAction onClick={onConfirm} disabled={disabled}>
						Execute
					</ConfirmationAction>
					<ConfirmationAction
						onClick={onDecline}
						disabled={disabled}
						variant="outline"
					>
						Decline
					</ConfirmationAction>
				</ConfirmationActions>
			</ConfirmationRequest>
		</Confirmation>
	);
}
