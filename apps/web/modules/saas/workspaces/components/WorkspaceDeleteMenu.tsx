"use client";

import { userMessageOf } from "@saas/shared/lib/user-message-of";
import { orpcClient } from "@shared/lib/orpc-client";
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
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The actions on a Workspace that only its author has, behind one "More"
 * control: deleting it. Deleting takes the page's data, files and comments with
 * it, so the author is asked first with the page named, and goes back to the
 * Workspaces list when it is gone.
 */
export function WorkspaceDeleteMenu({
	frameId,
	title,
	organizationId,
	organizationSlug,
}: {
	frameId: string;
	title: string;
	organizationId: string;
	organizationSlug: string;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	const remove = useMutation({
		mutationFn: () =>
			orpcClient.frames.delete({ id: frameId, organizationId }),
		onSuccess: async () => {
			setConfirming(false);
			toast.success("Workspace deleted");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["fabric-tool"] }),
				queryClient.invalidateQueries({ queryKey: ["frames"] }),
			]);
			router.push(`/app/${organizationSlug}/workspaces`);
		},
		onError: (error) => {
			toast.error("Could not delete this workspace", {
				description: userMessageOf(error, "Please try again."),
			});
		},
	});

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="More actions"
					>
						<MoreHorizontalIcon className="size-4" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() => setConfirming(true)}
					>
						<Trash2Icon className="mr-2 size-4" aria-hidden />
						Delete workspace
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<AlertDialog
				open={confirming}
				onOpenChange={(next) => {
					// Esc and a click outside leave a delete in progress alone.
					if (!next && remove.isPending) {
						return;
					}
					setConfirming(next);
				}}
			>
				<AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
					<AlertDialogHeader>
						<AlertDialogTitle className="break-words">
							Delete &ldquo;{title}&rdquo;?
						</AlertDialogTitle>
						<AlertDialogDescription>
							The page, and everything people saved in it (its
							data, files and comments), is removed for good. This
							cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={remove.isPending}
							onClick={(event) => {
								event.preventDefault();
								remove.mutate();
							}}
						>
							{remove.isPending
								? "Deleting..."
								: "Delete workspace"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
