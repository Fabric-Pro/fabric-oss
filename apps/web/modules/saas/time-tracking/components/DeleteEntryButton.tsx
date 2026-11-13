"use client";

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
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { invalidateTimeEntries } from "../lib/time-tracking-api";

/** Delete one of the caller's entries, after asking. */
export function DeleteEntryButton({
	entryId,
	summary,
	onDeleted,
}: {
	entryId: string;
	/** What is being deleted, e.g. "1h 30m of Development". */
	summary: string;
	onDeleted: () => void;
}) {
	const t = useTranslations("timeTracking.delete");
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () => orpc.timeTracking.deleteEntry.call({ entryId }),
		onSuccess: async () => {
			await invalidateTimeEntries(queryClient);
			toast.success(t("deleted"));
			onDeleted();
		},
		onError: () => {
			toast.error(t("failed"));
		},
	});

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="text-destructive"
					disabled={mutation.isPending}
				>
					{t("action")}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("title")}</AlertDialogTitle>
					<AlertDialogDescription>
						{t("description", { summary })}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => mutation.mutate()}
					>
						{t("confirm")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
