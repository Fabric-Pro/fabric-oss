"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { toast } from "sonner";

type AutomationTemplate = {
	id: string;
	name: string;
};

type Props = {
	template: AutomationTemplate | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string;
};

export function DeleteTemplateDialog({
	template,
	open,
	onOpenChange,
	organizationId,
}: Props) {
	const queryClient = useQueryClient();

	const deleteMutation = useMutation(
		orpc.automationTemplates.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Template deleted");
				queryClient.invalidateQueries({
					queryKey: ["automationTemplates"],
				});
				onOpenChange(false);
			},
			onError: (error) => {
				toast.error("Failed to delete template", {
					description: error.message,
				});
			},
		}),
	);

	if (!template) {
		return null;
	}

	const handleDelete = () => {
		deleteMutation.mutate({
			id: template.id,
			organizationId,
		});
	};

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete Template</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete "{template.name}"? This
						action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleDelete}
						disabled={deleteMutation.isPending}
						variant="destructive"
					>
						{deleteMutation.isPending ? (
							<Spinner className="h-4 w-4 mr-2" />
						) : null}
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
