"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

/**
 * "Remove folder" on one Living Memory folder: delete every file synced
 * under it (`projects.contexts.resetLivingMemory` with `folder`), files in
 * its subfolders included, the way "Reset Living Memory" deletes them all.
 *
 * The same gates as the full reset: an organization project, a member who
 * may delete any member's context source (`canDeleteContexts`), and no
 * connected repository sync, which would bring the files back and which the
 * server refuses too (the section's reset says why). Never on the project
 * root: removing it is the full reset. Destructive, so the dialog names the
 * folder and its file count and is confirmed only once the folder is typed
 * exactly.
 */
export function RemoveLivingMemoryFolder({
	projectId,
	organizationId,
	folderPath,
	fileCount,
	repositorySyncConnected,
	onRemoved,
}: {
	projectId: string;
	organizationId: string | null;
	/** The folder as the list groups it; `""` is the project root. */
	folderPath: string;
	/** Every synced file the removal deletes, subfolders included. */
	fileCount: number;
	repositorySyncConnected: boolean;
	onRemoved: () => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.removeFolder");
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const inputId = useId();

	const projectQuery = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const project = projectQuery.data?.project;

	const remove = useMutation(
		orpc.projects.contexts.resetLivingMemory.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					t("done", { folder: folderPath, count: result.deleted }),
				);
				setOpen(false);
				setTyped("");
				onRemoved();
			},
			onError: (error) => {
				toast.error(
					t("failed", { folder: folderPath, message: error.message }),
				);
			},
		}),
	);

	if (
		folderPath === "" ||
		!organizationId ||
		fileCount === 0 ||
		repositorySyncConnected ||
		!project?.canDeleteContexts
	) {
		return null;
	}
	const confirmed = typed.trim() === folderPath;

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={t("actionLabel", { folder: folderPath })}
				data-testid="living-memory-remove-folder"
				onClick={() => setOpen(true)}
			>
				<Trash2Icon className="mr-1.5 size-3.5" aria-hidden="true" />
				{t("action")}
			</Button>
			<AlertDialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) {
						setTyped("");
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("title", { folder: folderPath })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("description", {
								folder: folderPath,
								count: fileCount,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor={inputId}>
							{t("confirmLabel", { folder: folderPath })}
						</Label>
						<Input
							id={inputId}
							value={typed}
							autoComplete="off"
							spellCheck={false}
							data-testid="living-memory-remove-folder-name"
							onChange={(event) => setTyped(event.target.value)}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={!confirmed || remove.isPending}
							data-testid="living-memory-remove-folder-confirm"
							onClick={(event) => {
								// Keep the dialog open until the server answers.
								event.preventDefault();
								remove.mutate({
									projectId,
									folder: folderPath,
								});
							}}
						>
							{remove.isPending ? t("removing") : t("confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
