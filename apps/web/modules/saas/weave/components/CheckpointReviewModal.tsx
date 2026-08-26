"use client";

/**
 * CheckpointReviewModal - Modal for reviewing and approving checkpoints
 *
 * Shows checkpoint details and allows user to approve, request changes, or cancel
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Textarea } from "@ui/components/textarea";
import {
	CheckCircleIcon,
	Loader2Icon,
	PauseCircleIcon,
	XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface CheckpointReviewModalProps {
	/** Whether modal is open */
	isOpen: boolean;
	/** Called when modal should close */
	onClose: () => void;
	/** Execution ID */
	executionId: string;
	/** Workflow ID for signal */
	workflowId: string;
	/** Run ID for signal */
	runId: string;
	/** Checkpoint data from AgentApproval record */
	checkpoint?: {
		approvalId: string;
		stepId?: string;
		checkboxText?: string;
		agent?: string;
		reviewType?: string;
		result?: unknown;
		data?: unknown;
	} | null;
}

export function CheckpointReviewModal({
	isOpen,
	onClose,
	executionId,
	workflowId,
	runId,
	checkpoint,
}: CheckpointReviewModalProps) {
	const [feedback, setFeedback] = useState("");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	// Signal approval mutation
	const signalApprovalMutation = useMutation({
		mutationFn: async (approved: boolean) => {
			return await orpcClient.weave.executions.signalApproval({
				executionId,
				organizationId: organizationId ?? null,
				workflowId,
				runId,
				approved,
				feedback: feedback || undefined,
			});
		},
		onSuccess: (_, approved) => {
			toast.success(
				approved ? "Checkpoint approved!" : "Checkpoint rejected",
			);
			queryClient.invalidateQueries({
				queryKey: ["weave-execution", executionId],
			});
			setFeedback("");
			onClose();
		},
		onError: (error) => {
			toast.error(`Failed to signal checkpoint: ${error.message}`);
		},
	});

	if (!checkpoint) {
		return null;
	}

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<PauseCircleIcon className="size-5 text-yellow-500" />
						Checkpoint Review
					</DialogTitle>
					<DialogDescription>
						Review the agent's work before continuing execution
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-6 py-4">
					{/* Checkpoint Details */}
					<Card className="p-4">
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<span className="text-sm text-muted-foreground">
									Approval ID
								</span>
								<Badge
									variant="outline"
									className="font-mono text-xs"
								>
									{checkpoint.approvalId?.slice(0, 8)}...
								</Badge>
							</div>
							<div className="flex items-center justify-between">
								<span className="text-sm text-muted-foreground">
									Step
								</span>
								<Badge variant="outline">
									{checkpoint.stepId}
								</Badge>
							</div>
							<div className="flex items-center justify-between">
								<span className="text-sm text-muted-foreground">
									Agent
								</span>
								<Badge>{checkpoint.agent}</Badge>
							</div>
							{checkpoint.reviewType && (
								<div className="flex items-center justify-between">
									<span className="text-sm text-muted-foreground">
										Review Type
									</span>
									<Badge variant="secondary">
										{checkpoint.reviewType}
									</Badge>
								</div>
							)}
							<div className="pt-2">
								<span className="text-sm text-muted-foreground">
									Task:
								</span>
								<p className="mt-1 text-sm font-medium">
									{checkpoint.checkboxText}
								</p>
							</div>
						</div>
					</Card>

					{/* Data Preview */}
					{checkpoint.data != null ? (
						<Card className="p-4 bg-muted/50">
							<h4 className="mb-2 text-sm font-medium">
								Checkpoint Data:
							</h4>
							<pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
								{JSON.stringify(checkpoint.data, null, 2)}
							</pre>
						</Card>
					) : null}

					{/* Result Preview */}
					{checkpoint.result != null ? (
						<Card className="p-4 bg-muted/50">
							<h4 className="mb-2 text-sm font-medium">
								Result Preview:
							</h4>
							<pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
								{JSON.stringify(checkpoint.result, null, 2)}
							</pre>
						</Card>
					) : null}

					{/* Feedback */}
					<div className="space-y-2">
						<label
							htmlFor="checkpoint-feedback"
							className="text-sm font-medium"
						>
							Feedback (optional):
						</label>
						<Textarea
							id="checkpoint-feedback"
							placeholder="Add feedback or requested changes..."
							value={feedback}
							onChange={(e) => setFeedback(e.target.value)}
							rows={3}
						/>
					</div>

					{/* Actions */}
					<div className="flex items-center justify-end gap-3 pt-4">
						<Button
							variant="outline"
							onClick={() => signalApprovalMutation.mutate(false)}
							disabled={signalApprovalMutation.isPending}
							className="gap-2"
						>
							{signalApprovalMutation.isPending &&
							signalApprovalMutation.variables === false ? (
								<Loader2Icon className="size-4 animate-spin" />
							) : (
								<XCircleIcon className="size-4" />
							)}
							Reject
						</Button>

						<Button
							onClick={() => signalApprovalMutation.mutate(true)}
							disabled={signalApprovalMutation.isPending}
							className="gap-2"
						>
							{signalApprovalMutation.isPending ? (
								<Loader2Icon className="size-4 animate-spin" />
							) : (
								<CheckCircleIcon className="size-4" />
							)}
							Approve & Continue
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
