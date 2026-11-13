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
 * "Reset Living Memory": delete every file synced into the project's Living
 * Memory at once (`projects.contexts.resetLivingMemory`), the escape hatch
 * for a project whose synced files are in a bad state.
 *
 * Shown only to a member who may delete any member's context source
 * (`canDeleteContexts` on `projects.get`, the permission the procedure
 * requires), in an organization project with synced files. Destructive, so
 * the dialog states the scope with the count and is confirmed only once the
 * project's name is typed exactly. While a repository sync is connected the
 * action is disabled and says why: the sync would bring the files back, and
 * the server refuses it too.
 */
export function ResetLivingMemory({
	projectId,
	organizationId,
	syncedFileCount,
	repositorySyncConnected,
	onReset,
}: {
	projectId: string;
	organizationId: string | null;
	syncedFileCount: number;
	repositorySyncConnected: boolean;
	onReset: () => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.reset");
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const inputId = useId();
	const reasonId = useId();

	const projectQuery = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const project = projectQuery.data?.project;

	const reset = useMutation(
		orpc.projects.contexts.resetLivingMemory.mutationOptions({
			onSuccess: (result) => {
				toast.success(t("done", { count: result.deleted }));
				setOpen(false);
				setTyped("");
				onReset();
			},
			onError: (error) => {
				toast.error(t("failed", { message: error.message }));
			},
		}),
	);

	if (
		!organizationId ||
		syncedFileCount === 0 ||
		!project?.canDeleteContexts
	) {
		return null;
	}
	const projectName = project.name;
	const confirmed = typed.trim() === projectName;

	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={repositorySyncConnected}
				aria-describedby={
					repositorySyncConnected ? reasonId : undefined
				}
				data-testid="living-memory-reset"
				onClick={() => setOpen(true)}
			>
				<Trash2Icon className="mr-1.5 size-3.5" aria-hidden="true" />
				{t("action")}
			</Button>
			{repositorySyncConnected ? (
				<p
					id={reasonId}
					className="max-w-xs text-right text-muted-foreground text-xs"
				>
					{t("disabledSyncConnected")}
				</p>
			) : null}
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
						<AlertDialogTitle>{t("title")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("description", { count: syncedFileCount })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor={inputId}>
							{t("confirmLabel", { name: projectName })}
						</Label>
						<Input
							id={inputId}
							value={typed}
							autoComplete="off"
							spellCheck={false}
							data-testid="living-memory-reset-name"
							onChange={(event) => setTyped(event.target.value)}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={!confirmed || reset.isPending}
							data-testid="living-memory-reset-confirm"
							onClick={(event) => {
								// Keep the dialog open until the server answers.
								event.preventDefault();
								reset.mutate({ projectId });
							}}
						>
							{reset.isPending ? t("resetting") : t("confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
