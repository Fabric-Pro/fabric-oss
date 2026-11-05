"use client";

import type { ReportTemplatePublishTarget } from "@saas/reports/lib/report-template-publishing";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

export const PUBLISH_ACTION_LABEL: Record<ReportTemplatePublishTarget, string> =
	{
		ORGANIZATION: "Publish to organization",
		SYSTEM: "Publish to all organizations",
	};

const AUDIENCE: Record<ReportTemplatePublishTarget, string> = {
	ORGANIZATION: "every member of this organization",
	SYSTEM: "every organization",
};

const PUBLISHED_TOAST: Record<ReportTemplatePublishTarget, string> = {
	ORGANIZATION: "Template published to the organization",
	SYSTEM: "Template published to all organizations",
};

export type PublishReportTemplateRequest = {
	template: { id: string; name: string };
	target: ReportTemplatePublishTarget;
};

/**
 * Confirms publishing a template to a wider audience. There is no unpublish:
 * other people's reports may come to use the template, so it is removed by
 * archiving it, which keeps those reports running.
 */
export function PublishReportTemplateDialog({
	request,
	onClose,
}: {
	request: PublishReportTemplateRequest | null;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const publishMutation = useMutation(
		orpc.reports.templates.publish.mutationOptions({
			onSuccess: (_result, variables) => {
				toast.success(PUBLISHED_TOAST[variables.target]);
				queryClient.invalidateQueries({
					queryKey: orpc.reports.templates.list.key(),
				});
				onClose();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to publish the template");
			},
		}),
	);

	return (
		<AlertDialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open && !publishMutation.isPending) {
					onClose();
				}
			}}
		>
			{request && (
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{PUBLISH_ACTION_LABEL[request.target]}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							“{request.template.name}” becomes available to{" "}
							{AUDIENCE[request.target]}. Publishing can't be
							undone: to take the template away later, archive it.
							Reports already made from it keep running.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={publishMutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<Button
							disabled={publishMutation.isPending}
							onClick={() =>
								publishMutation.mutate({
									templateId: request.template.id,
									target: request.target,
								})
							}
						>
							{publishMutation.isPending && (
								<Loader2Icon
									aria-hidden="true"
									className="mr-2 h-4 w-4 motion-safe:animate-spin"
								/>
							)}
							Publish
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			)}
		</AlertDialog>
	);
}
