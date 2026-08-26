"use client";

/**
 * ApprovalDialog Component
 *
 * HITL approval dialog for high-risk operations in the orchestrator.
 * Shows the full task plan with all steps and visual indicators.
 */

import type { TaskPlan } from "@repo/temporal";
import { Badge } from "@ui/components/badge";
import { Textarea } from "@ui/components/textarea";
import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import {
	Confirmation,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationDescription,
	ConfirmationRequest,
	ConfirmationTitle,
} from "../../../../../../components/ai-elements/confirmation";
import { TaskPlanView } from "./TaskPlanView";

interface ApprovalDialogProps {
	stepId: string;
	description: string;
	riskLevel: string;
	onApprove: () => void;
	onReject: () => void;
	onFeedback: (feedback: string) => void;
	isSubmitting?: boolean;
	/** Full task plan to display */
	plan?: TaskPlan | null;
	/** Current step being executed */
	currentStepId?: string;
}

export function ApprovalDialog({
	stepId,
	description,
	riskLevel,
	onApprove,
	onReject,
	onFeedback,
	isSubmitting = false,
	plan,
	currentStepId,
}: ApprovalDialogProps) {
	const [feedbackMode, setFeedbackMode] = useState(false);
	const [feedback, setFeedback] = useState("");

	const handleFeedbackSubmit = () => {
		if (feedback.trim()) {
			onFeedback(feedback.trim());
			setFeedback("");
			setFeedbackMode(false);
		}
	};

	const getRiskBadgeVariant = () => {
		switch (riskLevel.toLowerCase()) {
			case "critical":
				return "destructive";
			case "high":
				return "destructive";
			case "medium":
				return "secondary";
			default:
				return "outline";
		}
	};

	return (
		<Confirmation className="max-w-2xl">
			<ConfirmationTitle className="flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 text-highlight" />
				Approval Required
				<Badge variant={getRiskBadgeVariant()}>{riskLevel} RISK</Badge>
			</ConfirmationTitle>

			{/* Show full task plan if available */}
			{plan && plan.steps.length > 0 && (
				<div className="mt-3 mb-2">
					<TaskPlanView
						plan={plan}
						currentStepId={currentStepId}
						pendingApprovalStepId={stepId}
						compact={false}
					/>
				</div>
			)}

			<ConfirmationDescription className="mt-2 whitespace-pre-wrap text-sm">
				{description}
			</ConfirmationDescription>
			<ConfirmationRequest>
				{feedbackMode ? (
					<div className="space-y-2 mt-3">
						<Textarea
							placeholder="Provide feedback or alternative instructions..."
							value={feedback}
							onChange={(e) => setFeedback(e.target.value)}
							className="min-h-20 text-sm"
							autoFocus
						/>
						<ConfirmationActions>
							<ConfirmationAction
								onClick={handleFeedbackSubmit}
								disabled={!feedback.trim() || isSubmitting}
								className="gap-1"
							>
								{isSubmitting && (
									<Loader2 className="h-4 w-4 animate-spin" />
								)}
								{isSubmitting ? "Sending..." : "Send Feedback"}
							</ConfirmationAction>
							<ConfirmationAction
								variant="ghost"
								onClick={() => {
									setFeedbackMode(false);
									setFeedback("");
								}}
							>
								Cancel
							</ConfirmationAction>
						</ConfirmationActions>
					</div>
				) : (
					<ConfirmationActions>
						<ConfirmationAction
							onClick={onApprove}
							variant="default"
							disabled={isSubmitting}
							className="bg-green-600 hover:bg-green-700 text-white border-green-600 hover:border-green-700 disabled:opacity-50 disabled:cursor-not-allowed gap-1"
						>
							{isSubmitting ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<CheckCircle2 className="h-4 w-4" />
							)}
							{isSubmitting ? "Approving..." : "Approve"}
						</ConfirmationAction>
						<ConfirmationAction
							variant="outline"
							onClick={onReject}
							disabled={isSubmitting}
							className="disabled:opacity-50 disabled:cursor-not-allowed gap-1"
						>
							{isSubmitting ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<XCircle className="h-4 w-4" />
							)}
							{isSubmitting ? "Declining..." : "Decline"}
						</ConfirmationAction>
						<ConfirmationAction
							variant="ghost"
							onClick={() => setFeedbackMode(true)}
							disabled={isSubmitting}
							className="disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<RefreshCw className="h-4 w-4 mr-1" />
							Provide Feedback
						</ConfirmationAction>
					</ConfirmationActions>
				)}
			</ConfirmationRequest>
		</Confirmation>
	);
}
