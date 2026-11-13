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
import { Trash2Icon } from "lucide-react";

/**
 * The trash control on an API key row, named for screen readers and confirmed
 * in the app's own dialog. A browser `confirm()` is unstyled, cannot be
 * themed, and some embedded browsers dismiss it without asking, which leaves
 * the key in place with no explanation.
 */
export function RevokeApiKeyButton({
	keyName,
	action,
	title,
	description,
	disabled,
	onConfirm,
}: {
	keyName: string;
	action: string;
	title: string;
	description: string;
	disabled: boolean;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={`${action} ${keyName}`}
					disabled={disabled}
				>
					<Trash2Icon
						className="size-4 text-destructive"
						aria-hidden="true"
					/>
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>
						{description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={onConfirm}
					>
						{action}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
