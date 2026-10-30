"use client";

import {
	APPROVAL_STALE_MESSAGE,
	type ApprovalSendResult,
	approvalSendResult,
} from "@saas/agents/lib/approval-response";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Loader2,
	ShieldAlert,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/** The person's answer to the card's approval. */
export interface ChatApprovalDecision {
	approved: boolean;
	feedback?: string;
}

type ChatApprovalCardProps = {
	approvalId: string;
	stepId: string;
	reason: string;
	organizationId?: string | null;
} & (
	| {
			/** Answered through the orchestrator's approve route for this execution. */
			executionId: string;
			onRespond?: never;
	  }
	| {
			/** Answered by the host (a multi-agent turn answers through its run). */
			onRespond: (
				decision: ChatApprovalDecision,
			) => Promise<ApprovalSendResult>;
			executionId?: never;
	  }
);

/** Send an answer through the orchestrator's approve route. */
async function sendToApproveRoute(
	executionId: string,
	approvalId: string,
	decision: ChatApprovalDecision,
): Promise<ApprovalSendResult> {
	const response = await fetch(
		"/api/agents/fabric-ai/orchestrator-temporal/approve",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				executionId,
				approved: decision.approved,
				feedback: decision.feedback,
				// The run takes the answer only for this card's approval.
				approvalId,
			}),
		},
	);
	const result = approvalSendResult(response);
	if (result === "failed") {
		const error = await response.json();
		throw new Error(error.error || "Failed to send approval");
	}
	return result;
}

export function ChatApprovalCard(props: ChatApprovalCardProps) {
	const { reason } = props;
	const respond = (answer: ChatApprovalDecision) =>
		props.onRespond
			? props.onRespond(answer)
			: sendToApproveRoute(props.executionId, props.approvalId, answer);
	const [feedback, setFeedback] = useState("");
	const [showFeedback, setShowFeedback] = useState(false);
	const [responded, setResponded] = useState(false);
	const [submittingAction, setSubmittingAction] = useState<
		"approve" | "reject" | null
	>(null);
	const [decision, setDecision] = useState<
		"approved" | "rejected" | "stale" | null
	>(null);

	const handleRespond = async (approved: boolean) => {
		// Set state synchronously BEFORE the async call to prevent icon flash
		const action = approved ? "approve" : "reject";
		setSubmittingAction(action);

		try {
			const result = await respond({
				approved,
				feedback: feedback.trim() || undefined,
			});
			if (result === "failed") {
				throw new Error("Failed to send approval");
			}

			if (result === "stale") {
				toast.info(APPROVAL_STALE_MESSAGE);
				setDecision("stale");
			} else {
				setDecision(approved ? "approved" : "rejected");
			}
			setResponded(true);
		} catch (error) {
			console.error("[ChatApprovalCard] Approval error:", error);
			toast.error(
				approved
					? "Failed to send approval"
					: "Failed to send rejection",
			);
		} finally {
			setSubmittingAction(null);
		}
	};

	const isSubmitting = submittingAction !== null;

	if (responded && decision === "stale") {
		return (
			<div className="mt-3 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
				<ShieldAlert className="h-4 w-4 shrink-0" />
				<span>{APPROVAL_STALE_MESSAGE}</span>
			</div>
		);
	}

	if (responded) {
		return (
			<div
				className={cn(
					"mt-3 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm",
					decision === "approved"
						? "border-green-200 bg-green-50 text-green-700 dark:border-green-900/50 dark:bg-green-950/20 dark:text-green-400"
						: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400",
				)}
			>
				{decision === "approved" ? (
					<CheckCircle2 className="h-4 w-4 shrink-0" />
				) : (
					<XCircle className="h-4 w-4 shrink-0" />
				)}
				<span>
					{decision === "approved"
						? "Approval accepted."
						: "Rejection accepted."}
				</span>
			</div>
		);
	}

	return (
		<div className="mt-3 rounded-xl border border-orange-200 bg-orange-50 dark:border-orange-900/50 dark:bg-orange-950/20">
			{/* Header */}
			<div className="flex items-start gap-3 px-4 py-3">
				<div className="mt-0.5 flex-shrink-0">
					<ShieldAlert className="h-5 w-5 text-orange-600 dark:text-orange-400" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-semibold text-orange-900 dark:text-orange-200">
						Approval Required
					</p>
					<p className="mt-0.5 text-sm leading-relaxed text-orange-700 dark:text-orange-300">
						{reason}
					</p>
				</div>
			</div>

			{/* Feedback toggle */}
			<div className="px-4 pb-1">
				<button
					type="button"
					onClick={() => setShowFeedback((v) => !v)}
					className="flex items-center gap-1 text-xs text-orange-600 transition-colors hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-200"
				>
					{showFeedback ? (
						<ChevronUp className="h-3 w-3" />
					) : (
						<ChevronDown className="h-3 w-3" />
					)}
					{showFeedback ? "Hide feedback" : "Add feedback (optional)"}
				</button>
				{showFeedback && (
					<Textarea
						value={feedback}
						onChange={(e) => setFeedback(e.target.value)}
						aria-label="Approval feedback"
						placeholder="Any instructions or context for the agent..."
						rows={2}
						className="mt-2 bg-white text-sm dark:bg-zinc-900"
					/>
				)}
			</div>

			{/* Actions */}
			<div className="flex items-center justify-end gap-2 border-t border-orange-200 px-4 py-3 dark:border-orange-900/50">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => handleRespond(false)}
					disabled={isSubmitting}
					className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/30 gap-1.5"
				>
					{submittingAction === "reject" && (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					)}
					{submittingAction !== "reject" && (
						<XCircle className="h-3.5 w-3.5" />
					)}
					<span>
						{submittingAction === "reject"
							? "Rejecting..."
							: "Reject"}
					</span>
				</Button>
				<Button
					size="sm"
					onClick={() => handleRespond(true)}
					disabled={isSubmitting}
					className="bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600 gap-1.5"
				>
					{submittingAction === "approve" && (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					)}
					{submittingAction !== "approve" && (
						<CheckCircle2 className="h-3.5 w-3.5" />
					)}
					<span>
						{submittingAction === "approve"
							? "Approving..."
							: "Approve"}
					</span>
				</Button>
			</div>
		</div>
	);
}
