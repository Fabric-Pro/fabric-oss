"use client";

/**
 * Cancel control for an in-progress report execution. Mirrors the security
 * "Group into tickets" cancel button: a ghost button that opens a confirmation
 * dialog, calls `reports.instances.cancelExecution`, and surfaces toast feedback.
 *
 * Precise visibility (R11): renders only for an active (PENDING/RUNNING) execution
 * AND only when the viewer may cancel it — the execution's owner, or an admin/owner
 * of its organization. Everyone else (a member viewing a teammate's org run) sees
 * nothing here; the backend enforces the same rule authoritatively. The component
 * self-hides (returns null) so both call sites can render it unconditionally.
 *
 * The race where a run completes just before the cancel lands is not an error:
 * the server returns `{ cancelled: false }` and we surface the real outcome.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

const ACTIVE_STATUSES = new Set(["PENDING", "RUNNING"]);

export function CancelExecutionButton({
	executionId,
	executionStatus,
	executionUserId,
	organizationId,
	viewerUserId,
	viewerIsOrgAdmin,
	onCancelled,
}: {
	executionId: string;
	executionStatus: string;
	executionUserId: string;
	/** The report's tenant: null for a personal run, the org id for an org run. */
	organizationId: string | null;
	viewerUserId: string | undefined;
	/** True when the viewer is an admin/owner of the active organization. */
	viewerIsOrgAdmin: boolean;
	/** Called after a cancel resolves so the parent can refetch execution state. */
	onCancelled: () => void;
}) {
	const cancelMutation = useMutation(
		orpc.reports.instances.cancelExecution.mutationOptions({
			onSuccess: (result) => {
				if (result.cancelled) {
					toast.success("Report generation cancelled");
				} else {
					// It finished before the cancel was processed — surface the
					// real outcome, not a cancellation error (R8 / F2).
					toast.success("Report already finished");
				}
				onCancelled();
			},
			onError: (error) => {
				toast.error(`Couldn't cancel report: ${error.message}`);
			},
		}),
	);

	const isActive = ACTIVE_STATUSES.has(executionStatus);
	const isOwner = !!viewerUserId && executionUserId === viewerUserId;
	const canCancel =
		isActive && (isOwner || (organizationId !== null && viewerIsOrgAdmin));

	if (!canCancel) {
		return null;
	}

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					disabled={cancelMutation.isPending}
					className="gap-1.5 text-muted-foreground"
					aria-label="Cancel this report generation"
				>
					{cancelMutation.isPending ? (
						<Loader2Icon
							aria-hidden="true"
							className="size-4 motion-safe:animate-spin"
						/>
					) : (
						<XIcon aria-hidden="true" className="size-4" />
					)}
					Cancel
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Stop this report?</AlertDialogTitle>
					<AlertDialogDescription>
						Generation will stop and any progress is lost. AI tokens
						already used won't be refunded.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Keep generating</AlertDialogCancel>
					<AlertDialogAction
						onClick={() =>
							cancelMutation.mutate({
								executionId,
								organizationId,
							})
						}
					>
						Stop report
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
