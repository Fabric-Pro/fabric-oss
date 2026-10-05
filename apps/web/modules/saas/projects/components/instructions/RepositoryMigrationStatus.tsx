"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useInstructionActionError } from "../../hooks/use-instruction-action-error";
import { safeHttpsUrl } from "../../lib/instructions-direct-commit";
import {
	type MigrationEndedNotice,
	migrationActions,
	migrationCommandRefusal,
	migrationFailureKey,
	type RepositoryMigrationView,
} from "../../lib/instructions-migration";
import type {
	RepositoryMigrationControls,
	RepositorySyncState,
} from "../../lib/instructions-repository-sync";

const NAMESPACE = "projects.codingInstructions.repositorySync.migration";

/**
 * Where a move of uploaded instructions into a repository stands (Fizzy #2878
 * §9), as one status line per state the server reports, in place of the sync
 * lines: the sync the move created is paused and says nothing a person could
 * act on. Everyone who reads the tab sees it; Cancel move and Retry exist only
 * for a member who may create and update.
 *
 * - preparing: the pull request is being opened;
 * - open: it awaits its merge, and the instructions stay as published until it
 *   merges, with the pull request's link and Cancel move;
 * - blocked: the typed failure in a sentence of its own, Retry when a retry can
 *   help, and Cancel move;
 * - merged and switching: the project is switching over, nothing to press;
 * - ended: the pull request was closed without merging, and what is left of
 *   the move waits to be cleaned up, which Cancel move also does.
 *
 * Every sentence is chosen by a code, never taken from the server's text.
 */
export function RepositoryMigrationStatus({
	projectId,
	state,
	migration,
	canManage,
	onChanged,
}: {
	projectId: string;
	state: RepositorySyncState;
	migration: RepositoryMigrationControls | undefined;
	canManage: boolean;
	/** Re-read what a cancel or a retry moved; resolves once it has settled. */
	onChanged: () => Promise<void> | void;
}) {
	const t = useTranslations(NAMESPACE);
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const read = migration?.read;
	const move = read?.migration ?? null;
	const configured = state.configured;
	const repository = read?.repository
		? `${read.repository.owner}/${read.repository.name}`
		: configured
			? `${configured.repositoryOwner}/${configured.repositoryName}`
			: t("repositoryFallback");
	const ref = read?.repository?.ref ?? configured?.ref ?? "";

	function refuse(error: unknown) {
		const reason = migrationCommandRefusal(error);
		toast.error(reason ? t(`commandErrors.${reason}`) : actionError(error));
		if (reason === "MIGRATION_NOT_OPEN") {
			void onChanged();
		}
	}
	const cancel = useMutation(
		orpc.projects.instructions.repositorySync.cancelMigration.mutationOptions(
			{
				onSuccess: async (result) => {
					toast.success(
						t(
							result.state === "CANCELING"
								? "canceledClosing"
								: "canceled",
						),
					);
					await onChanged();
				},
				onError: refuse,
			},
		),
	);
	const retry = useMutation(
		orpc.projects.instructions.repositorySync.retryMigration.mutationOptions(
			{
				onSuccess: async () => {
					toast.success(t("retried"));
					await onChanged();
				},
				onError: refuse,
			},
		),
	);
	const busy = cancel.isPending || retry.isPending;

	function askToCancel() {
		confirm({
			title: t("cancelConfirmTitle", { repository }),
			message: t("cancelConfirmMessage"),
			confirmLabel: t("cancelMove"),
			destructive: true,
			onConfirm: () => cancel.mutate({ projectId }),
		});
	}

	const pullRequestUrl = safeHttpsUrl(move?.pullRequest?.url);
	// Merged: the files are in the repository and the project is switching, so
	// there is nothing left to cancel and the pull request is no longer the news.
	const switching = move?.state === "MERGED" || move?.state === "SWITCHING";
	// What the server would accept: a project switched behind the move's back
	// refuses both, and its way out is Settings.
	const actions = migrationActions(
		move,
		state.migration?.state ?? "PROPOSING",
	);
	const canCancel = canManage && actions.cancel;
	const canRetry = canManage && actions.retry;

	return (
		<div
			role="status"
			aria-live="polite"
			className="flex flex-col gap-1 text-sm"
		>
			{move === null ? (
				<Working>{t("loading", { repository, ref })}</Working>
			) : (
				<MoveLine
					move={move}
					repository={repository}
					branch={ref}
					t={t}
				/>
			)}
			{pullRequestUrl && move !== null && !switching ? (
				<a
					href={pullRequestUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="w-fit text-primary underline-offset-2 hover:underline"
				>
					{t("viewPullRequest")}
				</a>
			) : null}
			{canRetry || canCancel ? (
				<div className="flex flex-wrap gap-2 pt-1">
					{canRetry ? (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => retry.mutate({ projectId })}
						>
							{t("retry")}
						</Button>
					) : null}
					{canCancel ? (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={askToCancel}
						>
							{t("cancelMove")}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

type Translate = (
	key: string,
	values?: Record<string, string | number>,
) => string;

function Working({ children }: { children: ReactNode }) {
	return (
		<p className="inline-flex items-center gap-1.5 text-primary">
			<Loader2Icon
				className="size-3.5 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			{children}
		</p>
	);
}

/** The sentence for the move's state. */
function MoveLine({
	move,
	repository,
	branch,
	t,
}: {
	move: RepositoryMigrationView;
	repository: string;
	branch: string;
	t: Translate;
}) {
	const number = move.pullRequest?.externalId ?? "";
	switch (move.state) {
		case "PROPOSING":
			return <Working>{t("preparing")}</Working>;
		case "OPEN":
			if (move.closing) {
				return (
					<Working>
						{number
							? t("closing", { number })
							: t("closingNoNumber")}
					</Working>
				);
			}
			return number ? (
				<p className="text-muted-foreground">
					{t("open", { repository, ref: branch, number })}
				</p>
			) : (
				<Working>{t("preparing")}</Working>
			);
		case "BLOCKED":
			return (
				<p className="text-destructive">
					{t("blocked", { repository, ref: branch })}{" "}
					{t(
						`failures.${migrationFailureKey(move.failure?.code ?? "")}`,
						{ repository, ref: branch },
					)}
				</p>
			);
		case "MERGED":
		case "SWITCHING":
			return <Working>{t("merged")}</Working>;
		case "ABANDONED":
			return (
				<p className="text-muted-foreground">
					{move.targetMismatch && number
						? t("abandonedMismatch", { number })
						: number
							? t("abandoned", { number })
							: t("abandonedNoNumber")}
				</p>
			);
		default: {
			const unreachable: never = move.state;
			return unreachable;
		}
	}
}

/**
 * What a move that ended without its files landing leaves behind once it is
 * gone: said until it is dismissed, because nothing else on the page says why
 * the instructions did not move.
 */
export function MigrationEndedNoticeLine({
	notice,
	onDismiss,
}: {
	notice: MigrationEndedNotice;
	onDismiss: () => void;
}) {
	const t = useTranslations(NAMESPACE);
	const repository = notice.repository ?? t("repositoryFallback");
	return (
		<div
			role="status"
			aria-live="polite"
			className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm"
		>
			<p>
				{notice.pullRequest
					? t(notice.mergedElsewhere ? "endedMismatch" : "ended", {
							repository,
							number: notice.pullRequest,
						})
					: t("endedNoPullRequest", { repository })}
			</p>
			<Button
				size="sm"
				variant="link"
				className="h-auto px-0"
				onClick={onDismiss}
			>
				{t("dismiss")}
			</Button>
		</div>
	);
}
