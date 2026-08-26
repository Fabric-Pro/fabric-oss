"use client";

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

interface ChatApprovalCardProps {
	approvalId: string;
	stepId: string;
	reason: string;
	executionId: string;
	organizationId?: string | null;
}

export function ChatApprovalCard({
	reason,
	executionId,
}: ChatApprovalCardProps) {
	const [feedback, setFeedback] = useState("");
	const [showFeedback, setShowFeedback] = useState(false);
	const [responded, setResponded] = useState(false);
	const [submittingAction, setSubmittingAction] = useState<
		"approve" | "reject" | null
	>(null);
	const [decision, setDecision] = useState<"approved" | "rejected" | null>(
		null,
	);

	const handleRespond = async (approved: boolean) => {
		// Set state synchronously BEFORE the async call to prevent icon flash
		const action = approved ? "approve" : "reject";
		setSubmittingAction(action);

		try {
			const response = await fetch(
				"/api/agents/fabric-ai/orchestrator-temporal/approve",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						executionId,
						approved,
						feedback: feedback.trim() || undefined,
					}),
				},
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to send approval");
			}

			setDecision(approved ? "approved" : "rejected");
			setResponded(true);
		} catch (error) {
			console.error("[ChatApprovalCard] Approval error:", error);
		} finally {
			setSubmittingAction(null);
		}
	};

	const isSubmitting = submittingAction !== null;

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
						? "Approved — continuing execution..."
						: "Rejected — workflow stopped."}
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
