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
import { TrashIcon } from "lucide-react";

/** The report page's delete control, confirmed before anything is removed. */
export function DeleteReportInstanceButton({
	instanceName,
	onDelete,
	isDeleting,
}: {
	instanceName: string;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					disabled={isDeleting}
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
