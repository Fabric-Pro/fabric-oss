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
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import {
	ExternalLinkIcon,
	GitCompareArrowsIcon,
	Loader2Icon,
	SearchIcon,
	Undo2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { InstructionCommitComparison } from "./InstructionsCompareDialog";

const BADGE_VARIANT: Record<
	CommitBadge,
	"success" | "destructive" | "outline"
> = {
	published: "success",
	refused: "destructive",
	notSynced: "outline",
};

type CommitEntry = { row: CommitRow; badge: CommitBadge | null };

/**
 * The synced branch's own history. The list remains paged and lazy, while its
 * selected commit gets a desktop detail pane for actions and an on-demand
 * comparison. On mobile the same two panes stack in reading order.
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
	provider: string;
	branch: string;
	rootPath: string;
	published: { sha: string | null; version: number | null };
	canRevert: boolean;
	pausedReason?: string | null;
	canCompare: boolean;
	syncRuns?: ReactNode;
	onChanged: () => void;
	onCommitted?: (commit: { sha: string; ref: string }) => void;
}) {
	const t = useTranslations("projects.codingInstructions.commits");
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const [cursors, setCursors] = useState<number[]>([1]);
	const [revertingSha, setRevertingSha] = useState<string | null>(null);
	const [selectedSha, setSelectedSha] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [showComparison, setShowComparison] = useState(false);

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
	const badges = commitBadges(loaded, published);
	const entries: CommitEntry[] = loaded.map((row, index) => ({
		row,
		badge: badges[index] ?? null,
	}));
	const normalizedFilter = filter.trim().toLocaleLowerCase();
	const visibleEntries = entries.filter(({ row }) => {
		if (normalizedFilter === "") {
			return true;
		}
		return [rowSubject(row) ?? "", row.author.name, row.sha]
			.join(" ")
			.toLocaleLowerCase()
			.includes(normalizedFilter);
	});
	const selectedEntry =
		visibleEntries.find(({ row }) => row.sha === selectedSha) ??
		(normalizedFilter === "" ? (visibleEntries[0] ?? null) : null);
	const last = pages[pages.length - 1];
	const nextCursor = last?.data?.nextCursor ?? null;
	const firstFailed = pages[0]?.isError ?? false;
	const folderMissing = firstFailed && isFolderNotFoundError(pages[0]?.error);
	const firstLoading = pages[0]?.isLoading ?? true;
	const provided = providerName(provider);

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

	function selectCommit(sha: string) {
		setSelectedSha(sha);
		setShowComparison(false);
	}

	function showCommitComparison(row: CommitRow) {
		setSelectedSha(row.sha);
		setShowComparison(true);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[85vh] max-h-[85vh] max-w-5xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>{t("title", { ref: branch })}</DialogTitle>
					<DialogDescription>
						{rootPath === ""
							? t("descriptionRoot", { ref: branch })
							: t("description", { ref: branch, rootPath })}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-3">
					<div className="relative w-full sm:max-w-xs">
						<SearchIcon
							className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<Input
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder={t("filterPlaceholder")}
							aria-label={t("filterLabel")}
							className="pl-9"
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						{t("loadedCount", { count: visibleEntries.length })}
					</p>
				</div>
				<div className="grid min-h-40 flex-1 grid-cols-1 overflow-hidden md:min-h-0 md:grid-cols-[minmax(17rem,0.9fr)_minmax(0,1.1fr)]">
					<div
						className="flex min-h-0 flex-col border-b border-border md:border-r md:border-b-0"
						aria-busy={firstLoading}
					>
						<div className="min-h-0 flex-1 overflow-auto py-1">
							{firstLoading ? (
								<div className="flex flex-col gap-2 p-3">
									<Skeleton className="h-16 w-full" />
									<Skeleton className="h-16 w-full" />
									<Skeleton className="h-16 w-full" />
								</div>
							) : firstFailed ? (
								<div
									role="alert"
									className="m-3 flex flex-col items-start gap-2 rounded-lg border border-border p-3 text-sm"
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
											onClick={() =>
												void pages[0]?.refetch()
											}
										>
											{t("retry")}
										</Button>
									)}
								</div>
							) : visibleEntries.length === 0 ? (
								<p className="p-3 text-muted-foreground text-sm">
									{loaded.length === 0
										? t("empty", { ref: branch })
										: t("filterEmpty")}
								</p>
							) : (
								<div
									aria-label={t("loadedListLabel")}
									className="flex flex-col"
								>
									{visibleEntries.map(({ row, badge }) => (
										<CommitListRow
											key={row.sha}
											row={row}
											badge={badge}
											selected={
												selectedEntry?.row.sha ===
												row.sha
											}
											onSelect={() =>
												selectCommit(row.sha)
											}
										/>
									))}
								</div>
							)}
						</div>
						{last?.isError && !firstFailed ? (
							<p
								role="alert"
								className="border-t border-border p-3 text-destructive text-sm"
							>
								{t("loadError")}
							</p>
						) : null}
						{nextCursor !== null ||
						(last?.isFetching && !firstLoading) ? (
							<div className="border-t border-border p-3">
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
					<CommitDetail
						entry={selectedEntry}
						providerLabel={provided}
						canRevert={canRevert}
						pausedReason={pausedReason}
						reverting={revertingSha}
						busy={revert.isPending}
						canCompare={canCompare}
						showComparison={showComparison}
						onShowComparison={showCommitComparison}
						onRevert={askToRevert}
						projectId={projectId}
					/>
				</div>
				{syncRuns ? (
					<details className="shrink-0 border-t border-border">
						<summary className="cursor-pointer px-1 py-3 text-muted-foreground text-sm">
							{t("syncRuns")}
						</summary>
						<div className="max-h-24 overflow-auto pb-1 md:max-h-40">
							{syncRuns}
						</div>
					</details>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function CommitListRow({
	row,
	badge,
	selected,
	onSelect,
}: {
	row: CommitRow;
	badge: CommitBadge | null;
	selected: boolean;
	onSelect: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.commits");
	const subject = rowSubject(row);
	return (
		<button
			type="button"
			data-testid="commit-row"
			aria-pressed={selected}
			onClick={onSelect}
			className="flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left text-sm last:border-b-0 hover:bg-accent aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
		>
			<div className="flex min-w-0 items-start justify-between gap-2">
				{subject === null ? (
					<p className="text-muted-foreground italic">
						{t("messageWithheld")}
					</p>
				) : (
					<p className="line-clamp-2 font-medium [overflow-wrap:anywhere]">
						{subject}
					</p>
				)}
				{badge ? (
					<Badge className="shrink-0" variant={BADGE_VARIANT[badge]}>
						{t(`${badge}Badge`)}
					</Badge>
				) : null}
			</div>
			<p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
				<code>{shortCommit(row.sha) ?? ""}</code>
				<span aria-hidden="true">·</span>
				<span>{row.author.name || t("anonymousAuthor")}</span>
				<span aria-hidden="true">·</span>
				<span>{formatRelativeTime(row.date)}</span>
			</p>
		</button>
	);
}

function CommitDetail({
	entry,
	providerLabel,
	canRevert,
	pausedReason,
	reverting,
	busy,
	canCompare,
	showComparison,
	onShowComparison,
	onRevert,
	projectId,
}: {
	entry: CommitEntry | null;
	providerLabel: string | null;
	canRevert: boolean;
	pausedReason: string | null;
	reverting: string | null;
	busy: boolean;
	canCompare: boolean;
	showComparison: boolean;
	onShowComparison: (row: CommitRow) => void;
	onRevert: (row: CommitRow) => void;
	projectId: string;
}) {
	const t = useTranslations("projects.codingInstructions.commits");
	if (entry === null) {
		return (
			<div
				data-testid="commit-detail"
				className="flex min-h-48 items-center p-4 text-muted-foreground text-sm"
			>
				{t("selectCommit")}
			</div>
		);
	}
	const { row, badge } = entry;
	const sha7 = shortCommit(row.sha) ?? "";
	const url = safeHttpsUrl(row.url);
	const subject = rowSubject(row);
	const canCompareRow = canCompare && row.parent !== null;
	const canRevertRow = canRevert && row.parent !== null;
	return (
		<div data-testid="commit-detail" className="min-h-0 overflow-auto p-4">
			<div className="flex flex-col gap-2 border-b border-border pb-4">
				<div className="flex flex-wrap items-start justify-between gap-2">
					{subject === null ? (
						<p className="text-muted-foreground text-sm italic">
							{t("messageWithheld")}
						</p>
					) : (
						<h3 className="font-medium text-base [overflow-wrap:anywhere]">
							{subject}
						</h3>
					)}
					{badge ? (
						<Badge variant={BADGE_VARIANT[badge]}>
							{t(`${badge}Badge`)}
						</Badge>
					) : null}
				</div>
				<p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
					<code>{sha7}</code>
					<span aria-hidden="true">·</span>
					<span>{row.author.name || t("anonymousAuthor")}</span>
					<span aria-hidden="true">·</span>
					<span>{formatRelativeTime(row.date)}</span>
				</p>
				<div className="flex flex-wrap gap-2">
					{canCompareRow ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => onShowComparison(row)}
						>
							<GitCompareArrowsIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							{t("compareAction")}
						</Button>
					) : null}
					{canRevertRow ? (
						<Button
							size="sm"
							variant="outline"
							aria-disabled={pausedReason ? true : undefined}
							className={pausedReason ? "opacity-50" : undefined}
							disabled={busy}
							onClick={
								pausedReason
									? () => toast.info(pausedReason)
									: () => onRevert(row)
							}
						>
							{reverting === row.sha ? (
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
							{t(
								reverting === row.sha
									? "reverting"
									: "revertAction",
							)}
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
			{showComparison && canCompareRow && row.parent !== null ? (
				<div
					data-testid="commit-comparison"
					className="mt-4 flex min-h-0 flex-col gap-4"
				>
					<InstructionCommitComparison
						key={`${row.parent}\0${row.sha}`}
						projectId={projectId}
						fromSha={row.parent}
						toSha={row.sha}
						open
					/>
				</div>
			) : null}
		</div>
	);
}
