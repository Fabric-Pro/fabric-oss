"use client";

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
import { Loader2Icon, TrashIcon } from "lucide-react";

/**
 * The report page's delete control, confirmed before anything is removed.
 * While the deletion runs it says so in words, not only by being disabled.
 */
export function DeleteReportInstanceButton({
	instanceName,
	onDelete,
	isDeleting,
}: {
	instanceName: string;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	if (isDeleting) {
		return (
			<Button variant="ghost" size="sm" disabled>
				<Loader2Icon
					aria-hidden="true"
					className="mr-2 h-4 w-4 motion-safe:animate-spin"
				/>
				<span role="status">Deleting…</span>
			</Button>
		);
	}
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Delete report instance"
				>
					<TrashIcon className="h-4 w-4 text-muted-foreground" />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Delete this report instance?
					</AlertDialogTitle>
					<AlertDialogDescription>
						This permanently deletes “{instanceName}” and its
						execution history. This can’t be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={onDelete}
						className="bg-destructive text-white hover:bg-destructive/90"
					>
						Delete instance
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
