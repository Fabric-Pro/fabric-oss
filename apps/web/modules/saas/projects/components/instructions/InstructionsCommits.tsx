"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import {
	type CommitBadge,
	type CommitRow,
	commitBadges,
	providerName,
	revertFailureKey,
	rowSubject,
} from "@saas/projects/lib/instructions-commits";
import { safeHttpsUrl } from "@saas/projects/lib/instructions-direct-commit";
import {
	isFolderNotFoundError,
	shortCommit,
} from "@saas/projects/lib/instructions-repository-sync";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import {
	ExternalLinkIcon,
	GitCompareArrowsIcon,
	Loader2Icon,
	Undo2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { InstructionsCompareDialog } from "./InstructionsCompareDialog";

const BADGE_VARIANT: Record<
	CommitBadge,
	"success" | "destructive" | "outline"
> = {
	published: "success",
	refused: "destructive",
	notSynced: "outline",
};

/**
 * The synced branch's history: what History is for a project whose
 * instructions come from a repository (Fizzy #2878 §10). The commits are the
 * branch's own, newest first and within the synced folder, a page of 30 at a
 * time; each says which of them Fabric's copy is of, which the secret scan
 * refused, and which Fabric has not taken yet.
 *
 * There are no versions to publish, roll back to or delete here: Fabric's copy
 * follows the branch. Rolling back is a revert COMMIT, which needs the same
 * right as a commit (INSTRUCTION_CREATE) and is the one write on this list.
 * The sync runs sit under it, as they did under History.
 *
 * Each page is its own query, so a page already read stays on screen while
 * the next one loads, and closing the dialog costs nothing; none is read until
 * the dialog opens.
 */
export function InstructionsCommits({
	projectId,
	open,
	onOpenChange,
	provider,
	branch,
	rootPath,
	published,
	canRevert,
	pausedReason = null,
	canCompare,
	syncRuns,
	onChanged,
	onCommitted,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The connected repository's provider, for "Open in <provider>". */
	provider: string;
	/** The synced branch. */
	branch: string;
	/** The synced folder; "" for the repository root. */
	rootPath: string;
	/** What Fabric's copy is of now: the commit and the version. */
	published: { sha: string | null; version: number | null };
	/** Whether this member may revert a commit (INSTRUCTION_CREATE, not Read-only mode). */
	canRevert: boolean;
	/**
	 * Why no revert can be made right now (uploaded instructions are being
	 * moved into this repository, Fizzy #2878 §9): Revert stays on its row,
	 * disabled, and pressing it says this instead of asking to confirm.
	 */
	pausedReason?: string | null;
	/**
	 * Whether this member may compare commits (INSTRUCTION_CREATE: the
	 * comparison reads file bodies from the repository, which is the right to
	 * change them). Not withheld in Read-only mode, which only refuses writes.
	 */
	canCompare: boolean;
	/** The repository's "Sync runs" list. */
	syncRuns?: ReactNode;
	onChanged: () => void;
	/** A revert landed on the branch: the tab waits for Fabric's copy to take it. */
	onCommitted?: (commit: { sha: string; ref: string }) => void;
}) {
	const t = useTranslations("projects.codingInstructions.commits");
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const [cursors, setCursors] = useState<number[]>([1]);
	const [revertingSha, setRevertingSha] = useState<string | null>(null);
	// The commit and its parent whose comparison is open, if any. Held here so
	// only ONE compare dialog is ever mounted.
	const [compare, setCompare] = useState<{
		from: string;
		to: string;
	} | null>(null);

	const pages = useQueries({
		queries: cursors.map((cursor) => ({
			...orpc.projects.instructions.repositorySync.listCommits.queryOptions(
				{
					input: { projectId, cursor },
				},
			),
			enabled: open,
		})),
	});
	const loaded = pages.flatMap((page) =>
		page.data ? (page.data.commits as CommitRow[]) : [],
	);
	const last = pages[pages.length - 1];
	const nextCursor = last?.data?.nextCursor ?? null;
	const firstFailed = pages[0]?.isError ?? false;
	const folderMissing = firstFailed && isFolderNotFoundError(pages[0]?.error);
	const firstLoading = pages[0]?.isLoading ?? true;
	const badges = commitBadges(loaded, published);

	const revert = useMutation(
		orpc.projects.instructions.revertCommit.mutationOptions({
			onSuccess: (result, variables) => {
				setRevertingSha(null);
				const sha7 = shortCommit(variables.sha) ?? "";
				if (result.outcome === "reverted") {
					toast.success(
						t("reverted", {
							sha7,
							newSha7: shortCommit(result.sha) ?? "",
							ref: result.ref,
						}),
					);
					onCommitted?.({ sha: result.sha, ref: result.ref });
				} else if (result.outcome === "unchanged") {
					toast.info(t("revertUnchanged", { sha7, ref: branch }));
				} else {
					toast.info(t("revertPending"));
				}
				void queryClient.invalidateQueries({
					queryKey:
						orpc.projects.instructions.repositorySync.listCommits.key(),
				});
				onChanged();
			},
			onError: (error) => {
				setRevertingSha(null);
				const key = revertFailureKey(error);
				toast.error(
					key
						? t(`revertFailures.${key}`, { ref: branch })
						: actionError(error),
				);
			},
		}),
	);

	function askToRevert(row: CommitRow) {
		const sha7 = shortCommit(row.sha) ?? "";
		confirm({
			title: t("revertConfirm", { sha7, ref: branch }),
			confirmLabel: t("revertConfirmAction"),
			destructive: true,
			onConfirm: () => {
				setRevertingSha(row.sha);
				revert.mutate({ projectId, sha: row.sha });
			},
		});
	}

	const provided = providerName(provider);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("title", { ref: branch })}</DialogTitle>
					<DialogDescription>
						{rootPath === ""
							? t("descriptionRoot", { ref: branch })
							: t("description", { ref: branch, rootPath })}
					</DialogDescription>
				</DialogHeader>
				<div
					className="flex max-h-[60vh] flex-col gap-2 overflow-auto"
					aria-busy={firstLoading}
				>
					{firstLoading ? (
						<>
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
						</>
					) : firstFailed ? (
						<div
							role="alert"
							className="flex flex-col items-start gap-2 rounded-lg border border-border p-3 text-sm"
						>
							<p className="text-destructive">
								{folderMissing
									? t("folderMissing", {
											folder: rootPath,
											ref: branch,
										})
									: t("loadError")}
							</p>
							{folderMissing ? null : (
								<Button
									size="sm"
									variant="outline"
									onClick={() => void pages[0]?.refetch()}
								>
									{t("retry")}
								</Button>
							)}
						</div>
					) : loaded.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							{t("empty", { ref: branch })}
						</p>
					) : (
						loaded.map((row, index) => (
							<CommitListRow
								key={row.sha}
								row={row}
								badge={badges[index] ?? null}
								providerLabel={provided}
								canRevert={canRevert && row.parent !== null}
								pausedReason={pausedReason}
								reverting={revertingSha === row.sha}
								busy={revert.isPending}
								onRevert={() => askToRevert(row)}
								onCompare={
									canCompare && row.parent !== null
										? () =>
												setCompare({
													from: row.parent as string,
													to: row.sha,
												})
										: undefined
								}
							/>
						))
					)}
					{last?.isError && !firstFailed ? (
						<p role="alert" className="text-destructive text-sm">
							{t("loadError")}
						</p>
					) : null}
					{nextCursor !== null ||
					(last?.isFetching && !firstLoading) ? (
						<div>
							<Button
								size="sm"
								variant="outline"
								disabled={last?.isFetching}
								onClick={() =>
									nextCursor !== null &&
									setCursors((current) => [
										...current,
										nextCursor,
									])
								}
							>
								{last?.isFetching ? (
									<Loader2Icon
										className="size-3.5 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								) : null}
								{t("loadMore")}
							</Button>
						</div>
					) : null}
				</div>
				{syncRuns}
			</DialogContent>
			{compare !== null ? (
				<InstructionsCompareDialog
					projectId={projectId}
					commits={compare}
					open
					onOpenChange={(next) => {
						if (!next) {
							setCompare(null);
						}
					}}
				/>
			) : null}
		</Dialog>
	);
}

/**
 * One commit: its short sha (linked to the provider), who and when, its
 * subject, what Fabric makes of it, and what can be done with it. A message the
 * secret scan withheld is said to be withheld, in the subject's place.
 */
function CommitListRow({
	row,
	badge,
	providerLabel,
	canRevert,
	pausedReason,
	reverting,
	busy,
	onRevert,
	onCompare,
}: {
	row: CommitRow;
	badge: CommitBadge | null;
	providerLabel: string | null;
	canRevert: boolean;
	pausedReason: string | null;
	reverting: boolean;
	busy: boolean;
	onRevert: () => void;
	/** Absent when this member may not compare, or the commit has no parent. */
	onCompare?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.commits");
	const sha7 = shortCommit(row.sha) ?? "";
	const url = safeHttpsUrl(row.url);
	const subject = rowSubject(row);
	return (
		<div
			data-testid="commit-row"
			className="flex flex-col gap-2 rounded-lg border border-border p-3"
		>
			{/* The actions sit under the commit at every width: three of them
			    beside it squeezed the subject and wrapped the author and age. */}
			<div className="flex flex-col gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					{subject === null ? (
						<p className="text-muted-foreground text-sm italic">
							{t("messageWithheld")}
						</p>
					) : (
						<p className="line-clamp-2 font-medium text-sm [overflow-wrap:anywhere]">
							{subject}
						</p>
					)}
					<p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
						{url ? (
							<a
								href={url}
								target="_blank"
								rel="noopener noreferrer"
								className="font-mono underline"
							>
								{sha7}
							</a>
						) : (
							<code>{sha7}</code>
						)}
						<span aria-hidden="true">·</span>
						<span>{row.author.name || t("anonymousAuthor")}</span>
						<span aria-hidden="true">·</span>
						<span>{formatRelativeTime(row.date)}</span>
					</p>
					{badge ? (
						<div className="flex flex-wrap items-center gap-1.5">
							<Badge variant={BADGE_VARIANT[badge]}>
								{t(`${badge}Badge`)}
							</Badge>
						</div>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2">
					{canRevert ? (
						<Button
							size="sm"
							variant="outline"
							// `aria-disabled`, not `disabled`: pressing a paused
							// Revert says why instead of doing nothing.
							aria-disabled={pausedReason ? true : undefined}
							className={pausedReason ? "opacity-50" : undefined}
							disabled={busy}
							onClick={
								pausedReason
									? () => toast.info(pausedReason)
									: onRevert
							}
						>
							{reverting ? (
								<Loader2Icon
									className="size-3.5 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<Undo2Icon
									className="size-3.5"
									aria-hidden="true"
								/>
							)}
							{t(reverting ? "reverting" : "revertAction")}
						</Button>
					) : null}
					{onCompare ? (
						<Button size="sm" variant="outline" onClick={onCompare}>
							<GitCompareArrowsIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							{t("compareAction")}
						</Button>
					) : null}
					{url && providerLabel ? (
						<Button size="sm" variant="ghost" asChild>
							<a
								href={url}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon
									className="size-3.5"
									aria-hidden="true"
								/>
								{t("openIn", { provider: providerLabel })}
							</a>
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
