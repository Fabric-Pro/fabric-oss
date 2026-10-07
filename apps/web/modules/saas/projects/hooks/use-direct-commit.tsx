"use client";

import type { InstructionChangeBase } from "@saas/projects/lib/instruction-change-source";
import {
	type CommitChange,
	type CommitRefusal,
	commitFailureKey,
	commitRefusal,
	type SettledCommit,
} from "@saas/projects/lib/instructions-direct-commit";
import { shortCommit } from "@saas/projects/lib/instructions-repository-sync";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import {
	DirectCommitBranchMovedDialog,
	DirectCommitPullRequestAlert,
	DirectCommitWatcher,
} from "../components/instructions/DirectCommitStatus";
import { useInstructionActionError } from "./use-instruction-action-error";

/** What a commit is made of: the version it was stated against, its words, and its changes. */
export type DirectCommitRequest = {
	message: string;
	changes: CommitChange[];
	/**
	 * "Suggest as a pull request" for this same change, offered by the
	 * branch-moved dialog. Never sent to the server; absent hides the button.
	 */
	suggest?: () => void;
} & InstructionChangeBase;

type Flow =
	| { phase: "idle" }
	| { phase: "submitting"; request: DirectCommitRequest }
	| {
			phase: "watching";
			request: DirectCommitRequest;
			snapshotId: string;
			native: boolean;
	  }
	| {
			phase: "pull-request";
			snapshotId: string;
			reason: "protected" | "busy";
	  }
	| { phase: "branch-moved"; request: DirectCommitRequest };

/**
 * "Commit to <branch>" as one flow for every surface that makes a commit (the
 * editor, Delete file, Rename and Add file): submit, wait for what became of
 * it, and say so in the person's own words.
 *
 * Returns `start`, `busy`, and `status`, an element the surface renders where
 * the answer belongs: the "Committing…" pill while it waits, the inline
 * pull-request notice when the branch refused the push, and the dialog when it
 * moved. What the surface does with its own draft is its to decide, through
 * the two callbacks:
 *
 * - `onFinished` when the change has been dealt with and the draft is done
 *   (committed, nothing to commit, opened as a pull request, or refused by the
 *   secret scan, whose findings the page's banner shows);
 * - nothing for a branch that moved or a commit that failed: the draft stays,
 *   so no typed change is lost to a retry.
 *
 * `messageRefusal` is the server's refusal of the commit message, kept until
 * the next start so it can sit under the message field it is about.
 */
export function useDirectCommit({
	projectId,
	branch,
	onChanged,
	onCommitted,
	onFinished,
}: {
	projectId: string;
	/** The synced branch, for the words. */
	branch: string;
	/** The tab's lists and published pointer should be re-read. */
	onChanged: () => unknown;
	/**
	 * A commit landed on the branch. Fabric's copy follows from a sync of the
	 * real tree a few seconds later, so the tab keeps reading until it has.
	 * A returned promise is awaited before the commit is announced.
	 */
	onCommitted?: (commit: { sha: string; ref: string }) => unknown;
	onFinished?: (result: SettledCommit) => void;
}): {
	start: (request: DirectCommitRequest) => void;
	busy: boolean;
	messageRefusal: CommitRefusal | null;
	clearMessageRefusal: () => void;
	status: ReactNode;
} {
	const t = useTranslations("projects.codingInstructions.commit");
	const actionError = useInstructionActionError();
	const [flow, setFlow] = useState<Flow>({ phase: "idle" });
	const [messageRefusal, setMessageRefusal] = useState<CommitRefusal | null>(
		null,
	);

	const submit = useMutation({
		mutationFn: (request: DirectCommitRequest) =>
			orpcClient.projects.instructions.commitChange({
				projectId,
				...(request.nativeBase
					? { nativeBase: request.nativeBase }
					: { baseSnapshotId: request.baseSnapshotId }),
				message: request.message,
				changes: request.changes,
			}),
		onSuccess: (result, request) => {
			setFlow({
				phase: "watching",
				request,
				snapshotId:
					result.kind === "native"
						? result.operationId
						: result.snapshotId,
				native: result.kind === "native",
			});
		},
		onError: (error: Error) => {
			setFlow({ phase: "idle" });
			const refusal = commitRefusal(error);
			if (refusal?.field === "message") {
				setMessageRefusal(refusal);
				return;
			}
			toast.error(
				refusal
					? t(`refusals.${refusal.key}`, { ref: branch })
					: actionError(error),
			);
		},
	});

	const start = useCallback(
		(request: DirectCommitRequest) => {
			setMessageRefusal(null);
			setFlow({ phase: "submitting", request });
			submit.mutate(request);
		},
		[submit],
	);

	const settled = useCallback(
		(result: SettledCommit) => {
			switch (result.kind) {
				case "committed":
					void (async () => {
						// The commit is announced once the page shows it, not
						// before: the old file would otherwise sit under the
						// toast until the re-read finishes.
						await Promise.allSettled([
							onChanged(),
							onCommitted?.({ sha: result.sha, ref: result.ref }),
						]);
						toast.success(
							t("committed", {
								sha7: shortCommit(result.sha) ?? "",
								ref: result.ref,
							}),
						);
						setFlow({ phase: "idle" });
						onFinished?.(result);
					})();
					return;
				case "unchanged":
					toast.info(t("unchanged"));
					setFlow({ phase: "idle" });
					onFinished?.(result);
					return;
				case "rejected":
					// The findings are in the page's rejected banner, which the
					// refreshed list brings up.
					toast.error(t("rejected"));
					setFlow({ phase: "idle" });
					onChanged();
					onFinished?.(result);
					return;
				case "pull-request":
					setFlow((current) =>
						current.phase === "watching"
							? {
									phase: "pull-request",
									snapshotId: current.snapshotId,
									reason: result.reason,
								}
							: current,
					);
					onChanged();
					onFinished?.(result);
					return;
				case "branch-moved":
					setFlow((current) =>
						current.phase === "watching"
							? {
									phase: "branch-moved",
									request: current.request,
								}
							: current,
					);
					return;
				case "failed":
					toast.error(
						t(`failures.${commitFailureKey(result.code)}`, {
							ref: branch,
						}),
					);
					setFlow({ phase: "idle" });
					return;
				default: {
					const unreachable: never = result;
					return unreachable;
				}
			}
		},
		[branch, onChanged, onCommitted, onFinished, t],
	);

	const busy = flow.phase === "submitting" || flow.phase === "watching";
	const status: ReactNode = (
		<>
			{flow.phase === "watching" ? (
				<DirectCommitWatcher
					key={flow.snapshotId}
					projectId={projectId}
					snapshotId={flow.snapshotId}
					native={flow.native}
					branch={branch}
					onSettled={settled}
				/>
			) : null}
			{flow.phase === "pull-request" ? (
				<DirectCommitPullRequestAlert
					projectId={projectId}
					snapshotId={flow.snapshotId}
					branch={branch}
					reason={flow.reason}
					onDismiss={() => setFlow({ phase: "idle" })}
				/>
			) : null}
			<DirectCommitBranchMovedDialog
				open={flow.phase === "branch-moved"}
				branch={branch}
				onCancel={() => setFlow({ phase: "idle" })}
				onRetry={() => {
					if (flow.phase === "branch-moved") {
						start(flow.request);
					}
				}}
				onSuggest={
					flow.phase === "branch-moved" && flow.request.suggest
						? () => {
								const suggest = flow.request.suggest;
								setFlow({ phase: "idle" });
								suggest?.();
							}
						: undefined
				}
			/>
		</>
	);

	return {
		start,
		busy,
		messageRefusal,
		clearMessageRefusal: () => setMessageRefusal(null),
		status,
	};
}
