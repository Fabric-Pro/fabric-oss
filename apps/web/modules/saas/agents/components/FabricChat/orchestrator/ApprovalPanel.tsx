"use client";

import type { TaskPlan } from "@repo/temporal";
import { useChatApproval } from "@saas/agents/hooks/useChatApproval";
import {
	APPROVAL_STALE_MESSAGE,
	type ApprovalSendResult,
} from "@saas/agents/lib/approval-response";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { useState } from "react";
import { toast } from "sonner";
import { ApprovalDialog } from "./ApprovalDialog";

interface ApprovalPanelProps {
	executionId?: string | null;
	pending: { approvalId?: string; stepId: string; reason: string };
	plan: TaskPlan | null;
	currentStepId?: string;
	sendApproval?: (
		approved: boolean,
		feedback?: string,
	) => Promise<ApprovalSendResult>;
	onDecision: (decision: {
		approvalId: string;
		stepId: string;
		approved: boolean;
		feedback?: string;
	}) => void;
}

/** Presentation and decision state stay out of the conversation container. */
export function ApprovalPanel({
	executionId,
	pending,
	plan,
	currentStepId,
	sendApproval,
	onDecision,
}: ApprovalPanelProps) {
	const approval = useChatApproval(executionId, pending.approvalId);
	const [isSendingViaStream, setIsSendingViaStream] = useState(false);
	const match = pending.reason.match(
		/^(LOW|MEDIUM|HIGH|CRITICAL) RISK(?: PLAN)?:\s*/i,
	);
	const respond = async (
		approved: boolean,
		feedback?: string,
		kind: "approve" | "reject" | "feedback" = approved
			? "approve"
			: "reject",
	) => {
		const approvalId = pending.approvalId ?? `approval-${Date.now()}`;
		if (sendApproval) {
			setIsSendingViaStream(true);
			try {
				onDecision({
					approvalId,
					stepId: pending.stepId,
					approved,
					feedback,
				});
				const result = await sendApproval(approved, feedback);
				if (result === "sent") {
					if (kind === "approve") {
						toast.success("Approved - execution continuing");
					} else if (kind === "feedback") {
						toast.info("Feedback sent - execution will adjust");
					} else {
						toast.info("Rejected - execution stopped");
					}
				} else if (result === "stale") {
					toast.info(APPROVAL_STALE_MESSAGE);
				} else {
					toast.error(
						kind === "approve"
							? "Failed to send approval"
							: kind === "feedback"
								? "Failed to send feedback"
								: "Failed to send rejection",
					);
				}
			} finally {
				setIsSendingViaStream(false);
			}
			return;
		}
		if (
			pending.approvalId &&
			(await approval.respond(approved, feedback))
		) {
			onDecision({
				approvalId: pending.approvalId,
				stepId: pending.stepId,
				approved,
				feedback,
			});
		}
	};
	return (
		<div className="flex gap-3">
			<FabricLogo className="h-8 w-8 shrink-0" size={32} />
			<div className="flex-1">
				<ApprovalDialog
					stepId={pending.stepId}
					description={
						match
							? pending.reason.slice(match[0].length)
							: pending.reason
					}
					riskLevel={match?.[1].toUpperCase() ?? "MEDIUM"}
					onApprove={() => void respond(true, undefined, "approve")}
					onReject={() =>
						void respond(false, "Rejected by user", "reject")
					}
					onFeedback={(feedback) =>
						void respond(false, feedback.trim(), "feedback")
					}
					isSubmitting={
						sendApproval
							? isSendingViaStream
							: approval.isSubmitting
					}
					disabled={
						sendApproval ? isSendingViaStream : approval.disabled
					}
					plan={plan}
					currentStepId={currentStepId}
				/>
				{approval.error && (
					<p role="alert" className="mt-2 text-sm text-destructive">
						{approval.error}
					</p>
				)}
				{approval.decision !== null && (
					<output
						aria-live="polite"
						className="mt-2 block text-sm text-muted-foreground"
					>
						{approval.decision
							? "Approval accepted."
							: "Rejection accepted."}
					</output>
				)}
			</div>
		</div>
	);
}
