"use client";

import {
	COMMIT_GIVE_UP_MS,
	commitPollInterval,
	type SettledCommit,
	safeHttpsUrl,
	settledCommit,
} from "@saas/projects/lib/instructions-direct-commit";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	ExternalLinkIcon,
	GitPullRequestIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";

/**
 * Waits for one direct commit to end, and says so once it has.
 *
 * `commitChange` answers at once with a snapshot id; the secret scan and the
 * push happen after. The snapshot is the only place the result is recorded, so
 * this re-reads it (`instructions.get`) until `settledCommit` has an answer,
 * quickly at first and then slowly, and stops waiting after
 * `COMMIT_GIVE_UP_MS`: a commit whose workflow never reports must not leave a
 * spinner up for ever. The page already polls its own list for the published
 * pointer; this is the one poll that answers "what became of MY commit".
 *
 * Mounted only while a commit is in flight, which is also why the query lives
 * here and not in the view that starts it: a view that never commits never
 * asks for it.
 */
export function DirectCommitWatcher({
	projectId,
	snapshotId,
	branch,
	onSettled,
}: {
	projectId: string;
	snapshotId: string;
	branch: string;
	onSettled: (result: SettledCommit) => void;
}) {
	const t = useTranslations("projects.codingInstructions.commit");
	const startedAt = useRef(Date.now());
	const reported = useRef(false);
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;

	const report = useCallback((result: SettledCommit) => {
		if (reported.current) {
			return;
		}
		reported.current = true;
		onSettledRef.current(result);
	}, []);

	const snapshot = useQuery({
		...orpc.projects.instructions.get.queryOptions({
			input: { projectId, snapshotId },
		}),
		retry: 2,
		refetchInterval: (query) => {
			const row = query.state.data;
			if (row && settledCommit(row) !== null) {
				return false;
			}
			return commitPollInterval(Date.now() - startedAt.current);
		},
	});

	const result = snapshot.data ? settledCommit(snapshot.data) : null;
	const resultKind = result?.kind ?? null;
	useEffect(() => {
		if (result !== null) {
			report(result);
		}
		// `result` is derived from the same row `resultKind` names; the kind is
		// the dependency so a refetch that changes nothing does not re-run it.
	}, [resultKind, report]);
	useEffect(() => {
		if (snapshot.isError && !snapshot.data) {
			report({ kind: "failed", code: "UNKNOWN", retryable: true });
		}
	}, [snapshot.isError, snapshot.data, report]);
	useEffect(() => {
		const timer = setTimeout(
			() =>
				report({
					kind: "failed",
					code: "VALIDATION_TIMEOUT",
					retryable: true,
				}),
			COMMIT_GIVE_UP_MS,
		);
		return () => clearTimeout(timer);
	}, [report]);

	return (
		<output className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-sm">
			<Loader2Icon
				className="size-3.5 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			{t("committing", { ref: branch })}
		</output>
	);
}

/**
 * The pull request a commit fell back to, as a link once Fabric has opened it.
 *
 * The change was admitted again as an ordinary suggestion, so its pull request
 * is the one `getPullRequestStatus` reads; it is queued until the provider
 * answers, so this keeps asking (every 5 s, for a bounded run) until there is a
 * URL to give, and says "Fabric is opening the pull request" meanwhile.
 */
function PullRequestLink({
	projectId,
	snapshotId,
}: {
	projectId: string;
	snapshotId: string;
}) {
	const t = useTranslations("projects.codingInstructions.commit");
	const status = useQuery({
		...orpc.projects.instructions.proposals.getPullRequestStatus.queryOptions(
			{ input: { projectId, snapshotId } },
		),
		retry: 1,
		refetchInterval: (query) =>
			query.state.data?.pullRequest?.url ||
			query.state.dataUpdateCount > 36
				? false
				: 5_000,
	});
	const url = safeHttpsUrl(status.data?.pullRequest?.url);
	if (url) {
		return (
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1.5 font-medium underline"
			>
				{t("pullRequestLink")}
				<ExternalLinkIcon className="size-3.5" aria-hidden="true" />
			</a>
		);
	}
	return <span>{t("pullRequestOpening")}</span>;
}

/**
 * The branch refused the push, or kept moving, so the same change was opened as
 * a pull request. Inline, not a toast: the link is the next step, and it has to
 * still be there when the person looks back.
 */
export function DirectCommitPullRequestAlert({
	projectId,
	snapshotId,
	branch,
	reason,
	onDismiss,
}: {
	projectId: string;
	snapshotId: string;
	branch: string;
	reason: "protected" | "busy";
	onDismiss?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.commit");
	return (
		<Alert variant="warning" role="status">
			<GitPullRequestIcon aria-hidden="true" />
			<AlertTitle>
				{t(reason === "protected" ? "protectedTitle" : "busyTitle", {
					ref: branch,
				})}
			</AlertTitle>
			<AlertDescription className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<PullRequestLink
					projectId={projectId}
					snapshotId={snapshotId}
				/>
				{onDismiss ? (
					<Button size="sm" variant="ghost" onClick={onDismiss}>
						{t("dismiss")}
					</Button>
				) : null}
			</AlertDescription>
		</Alert>
	);
}

/**
 * Someone changed one of these files on the branch since the edit began, so
 * nothing was written. Three ways on, none of which loses the typed change:
 * commit again (the branch is checked afresh), suggest it as a pull request so
 * it is reviewed against the new commit, or stay in the editor and cancel.
 */
export function DirectCommitBranchMovedDialog({
	open,
	branch,
	onRetry,
	onSuggest,
	onCancel,
}: {
	open: boolean;
	branch: string;
	onRetry: () => void;
	/** Absent for someone who cannot suggest (never the case for a committer today). */
	onSuggest?: () => void;
	onCancel: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.commit");
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{t("branchMovedTitle", { ref: branch })}
					</DialogTitle>
					<DialogDescription>
						{t("branchMovedBody", { ref: branch })}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={onCancel}>
						{t("cancel")}
					</Button>
					{onSuggest ? (
						<Button variant="outline" onClick={onSuggest}>
							{t("suggestButton")}
						</Button>
					) : null}
					<Button onClick={onRetry}>{t("retryCommit")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
