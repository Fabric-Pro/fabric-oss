"use client";

/**
 * Confirmation gate for a FULL re-index of one repository. A full rebuild
 * re-embeds the entire repo and consumes embedding credits, so it sits behind
 * this dialog — the fast "Update index" (incremental) path is the routine one.
 * Destructive action styling; design tokens only.
 */

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
import { buttonVariants } from "@ui/components/button";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

interface FullReindexConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	repoLabel: string;
	isReindexing: boolean;
	onConfirm: () => void;
}

export function FullReindexConfirmDialog({
	open,
	onOpenChange,
	repoLabel,
	isReindexing,
	onConfirm,
}: FullReindexConfirmDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{`Re-index ${repoLabel} from scratch?`}</AlertDialogTitle>
					<AlertDialogDescription>
						A full re-index re-embeds the entire repository and
						consumes embedding credits. For routine updates prefer{" "}
						<strong>Update index</strong>, which re-embeds only the
						files changed since the last index. Use a full re-index
						when the index looks wrong or after a force-push.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isReindexing}>
						Cancel
					</AlertDialogCancel>
					<AlertDialogAction
						className={buttonVariants({ variant: "destructive" })}
						onClick={(e) => {
							e.preventDefault();
							onConfirm();
						}}
						disabled={isReindexing}
					>
						{isReindexing ? (
							<>
								<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
								Starting…
							</>
						) : (
							<>
								<RefreshCwIcon className="mr-2 size-4" />
								Full re-index
							</>
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
