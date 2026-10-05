"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useInstructionActionError } from "./use-instruction-action-error";

/**
 * "Discard this upload": deletes an upload that was begun and never finalized
 * (Fizzy #2878 follow-up), after a destructive confirmation. The header's
 * "Checking your upload" state and History's "Upload did not finish" row both
 * call it, so a stuck row is recoverable from either, including one left by a
 * tab that was closed.
 *
 * The server decides whether the row may go (the creator, or someone who may
 * delete; never one `finalize` has claimed), and a refusal is worded by its
 * code like every other failed action. Either way the tab re-reads, so what
 * the person sees is what the server now holds.
 */
export function useDiscardUpload({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged: () => void;
}): { discard: (snapshotId: string) => void; pending: boolean } {
	const t = useTranslations("projects.codingInstructions.discardUpload");
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const remove = useMutation(
		orpc.projects.instructions.delete.mutationOptions({
			onSuccess: () => {
				toast.success(t("discarded"));
				onChanged();
			},
			onError: (error) => {
				toast.error(actionError(error));
				onChanged();
			},
		}),
	);
	return {
		discard: (snapshotId) =>
			confirm({
				title: t("confirmTitle"),
				message: t("confirmBody"),
				confirmLabel: t("confirmAction"),
				destructive: true,
				onConfirm: () => remove.mutate({ projectId, snapshotId }),
			}),
		pending: remove.isPending,
	};
}
