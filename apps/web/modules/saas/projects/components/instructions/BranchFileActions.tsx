"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { BranchMarker, BranchProjectionFile } from "./lib/branch-files";
import { invalidateProposalViews } from "./lib/instructions-proposal-views";

/**
 * The caller's own accepting proposal branch, as `proposals.myBranch` projects
 * it: its id and what it holds per path. Shares the query the branch panel
 * and the file view read, so it costs no extra request.
 */
export function useMyBranchFiles(projectId: string, enabled: boolean) {
	const query = useQuery({
		...orpc.projects.instructions.proposals.myBranch.queryOptions({
			input: { projectId },
		}),
		enabled,
	});
	const files: BranchProjectionFile[] = query.data?.files ?? [];
	return { branchId: query.data?.branch?.id ?? null, files };
}

/**
 * "Restore published version" and "Delete from my branch", each confirmed
 * and then sent as one ordinary proposal on the caller's own branch. The
 * server reads the published bytes itself: a file the published version has
 * is put back, a file only the branch holds is deleted.
 */
export function useRestoreBranchFile({
	projectId,
	nativeBase,
	onChanged,
}: {
	projectId: string;
	/** The published pin the restore is read from; null while it is unknown. */
	nativeBase: NativeInstructionBase | null;
	onChanged?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.branchFiles");
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const restore = useMutation(
		orpc.projects.instructions.proposals.restoreMyBranchFile.mutationOptions(
			{
				onSuccess: (result) => {
					toast.success(
						t(
							result.operation === "delete"
								? "deleteSuccess"
								: "restoreSuccess",
						),
					);
					void invalidateProposalViews(queryClient);
					onChanged?.();
				},
				onError: (error: Error) => toast.error(actionError(error)),
			},
		),
	);
	const request = (path: string, marker: BranchMarker) => {
		if (nativeBase === null) {
			return;
		}
		const deleting = marker === "branchOnly";
		confirm({
			title: t(deleting ? "deleteConfirmTitle" : "restoreConfirmTitle", {
				path,
			}),
			message: t(
				deleting ? "deleteConfirmMessage" : "restoreConfirmMessage",
			),
			confirmLabel: t(deleting ? "deleteFromBranch" : "restore"),
			destructive: true,
			onConfirm: () =>
				restore.mutate({
					projectId,
					nativeBase,
					path,
				}),
		});
	};
	return {
		request,
		pending: restore.isPending,
		available: nativeBase !== null,
	};
}

export type BranchFileRestore = ReturnType<typeof useRestoreBranchFile>;

/** The one action a branch marker offers. */
export function BranchFileActionButton({
	path,
	marker,
	restore,
}: {
	path: string;
	marker: BranchMarker;
	restore: BranchFileRestore;
}) {
	const t = useTranslations("projects.codingInstructions.branchFiles");
	const label = t(marker === "branchOnly" ? "deleteFromBranch" : "restore");
	return (
		<Button
			size="sm"
			variant="outline"
			disabled={restore.pending || !restore.available}
			aria-label={t("actionLabel", { action: label, path })}
			onClick={() => restore.request(path, marker)}
		>
			{label}
		</Button>
	);
}

/**
 * Above a published file the caller's branch changes or deletes: says so,
 * and offers to put the published version back on the branch. A changed
 * file's notice does not say which version is shown: the viewer shows the
 * branch's bytes when Fabric holds them and says so in its own toolbar,
 * and otherwise says the branch version cannot be shown.
 */
export function BranchFileNotice({
	path,
	marker,
	restore,
}: {
	path: string;
	marker: Exclude<BranchMarker, "branchOnly">;
	restore: BranchFileRestore;
}) {
	const t = useTranslations("projects.codingInstructions.branchFiles");
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 border-border border-b bg-muted/40 px-5 py-2 text-sm">
			<p className="text-muted-foreground">
				{t(
					marker === "deletedOnBranch"
						? "deletedNotice"
						: "changedNotice",
				)}
			</p>
			<BranchFileActionButton
				path={path}
				marker={marker}
				restore={restore}
			/>
		</div>
	);
}
