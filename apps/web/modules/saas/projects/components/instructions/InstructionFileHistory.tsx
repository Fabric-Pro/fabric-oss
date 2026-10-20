"use client";

import type {
	CommittedCallback,
	RereadCallback,
} from "@saas/projects/hooks/use-direct-commit";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { rereadInstructionCommit } from "@saas/projects/lib/instruction-commit-reread";
import type { SettledCommit } from "@saas/projects/lib/instructions-direct-commit";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
	DirectCommitPullRequestAlert,
	DirectCommitWatcher,
} from "./DirectCommitStatus";
import {
	type FileRestoreRequest,
	InstructionFileHistoryContent,
} from "./InstructionFileHistoryContent";

type Operation = {
	projectId: string;
	path: string;
	operationId: string;
	branch: string;
	deleted: boolean;
	result: SettledCommit | null;
};

export function InstructionFileHistory({
	projectId,
	path,
	canRestore,
	blockedReason,
	onChanged,
	onCommitted,
}: {
	projectId: string;
	path: string;
	canRestore: boolean;
	blockedReason: string | null;
	onChanged?: RereadCallback;
	onCommitted?: CommittedCallback;
}) {
	const t = useTranslations("projects.codingInstructions.fileHistory");
	const actionError = useInstructionActionError();
	const [open, setOpen] = useState(false);
	const [revision, setRevision] = useState(0);
	const [operation, setOperation] = useState<Operation | null>(null);
	const [submissionError, setSubmissionError] = useState<string | null>(null);
	const [stale, setStale] = useState(false);
	const identity = `${projectId}:${path}`;
	const current = useRef({
		identity,
		canRestore,
		blockedReason,
		onChanged,
		onCommitted,
	});
	current.current = {
		identity,
		canRestore,
		blockedReason,
		onChanged,
		onCommitted,
	};
	const admitting = useRef(false);
	useEffect(() => {
		setOpen(false);
		setSubmissionError(null);
		setStale(false);
	}, [identity]);
	const restore = useMutation({
		mutationFn: (request: FileRestoreRequest & { branch: string }) => {
			if (
				current.current.identity !==
					`${request.projectId}:${request.path}` ||
				!current.current.canRestore ||
				current.current.blockedReason
			) {
				throw new Error("Restore is no longer available");
			}
			const { branch: _branch, ...input } = request;
			return orpcClient.projects.instructions.repository.restoreFile(
				input,
			);
		},
		onSuccess: (result, request) => {
			if (result.kind === "native") {
				setOperation({
					projectId: request.projectId,
					path: request.path,
					operationId: result.operationId,
					branch: request.branch,
					deleted: result.deleteCount > 0,
					result: null,
				});
			} else if (
				current.current.identity ===
				`${request.projectId}:${request.path}`
			) {
				setSubmissionError(t("unchanged"));
			}
		},
		onError: (error, request) => {
			if (
				current.current.identity !==
				`${request.projectId}:${request.path}`
			) {
				return;
			}
			setSubmissionError(actionError(error));
			// A refused preview is never retried against a different branch head.
			setStale(true);
		},
		onSettled: () => {
			admitting.current = false;
		},
	});
	const pending =
		restore.isPending ||
		operation?.result === null ||
		operation?.result?.kind === "pull-request";
	const refresh = () => {
		setRevision((value) => value + 1);
		setSubmissionError(null);
		setStale(false);
	};
	const settle = (result: SettledCommit) => {
		if (!operation) {
			return;
		}
		setOperation({ ...operation, result });
		if (
			`${operation.projectId}:${operation.path}` !==
			current.current.identity
		) {
			return;
		}
		if (result.kind === "branch-moved") {
			setStale(true);
		}
		if (result.kind === "committed") {
			refresh();
			const callbacks = current.current;
			void rereadInstructionCommit([
				() =>
					operation.deleted
						? undefined
						: callbacks.onCommitted?.({
								sha: result.sha,
								ref: result.ref,
							}),
				() => callbacks.onChanged?.(),
			]).then((reread) => {
				if (
					current.current.identity === callbacks.identity &&
					reread !== "success"
				) {
					setSubmissionError(t("rereadFailed"));
				}
			});
		}
	};
	const settledStatus =
		operation && operation.result !== null ? (
			<div className="space-y-1 text-sm" role="status">
				<p className="break-all font-mono text-xs">{operation.path}</p>
				<RestoreOperationStatus
					operation={operation}
					result={operation.result}
					onDismiss={() => setOperation(null)}
				/>
			</div>
		) : null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (next) refresh();
				}}
			>
				<DialogTrigger asChild>
					<Button variant="ghost" size="sm">
						<HistoryIcon className="size-4" aria-hidden="true" />
						{t("button")}
					</Button>
				</DialogTrigger>
				<DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{t("title", { path })}</DialogTitle>
						<DialogDescription>
							{t("description")}
						</DialogDescription>
					</DialogHeader>
					{open && operation?.result === null ? (
						<div
							className="space-y-1 text-sm"
							role="status"
							aria-label={t("pending")}
						>
							<p className="break-all font-mono text-xs">
								{operation.path}
							</p>
							<p>{t("pending")}</p>
						</div>
					) : null}
					{open ? settledStatus : null}
					{open ? (
						<InstructionFileHistoryContent
							key={`${identity}:${revision}`}
							projectId={projectId}
							path={path}
							canRestore={canRestore}
							blockedReason={
								blockedReason ?? (pending ? t("pending") : null)
							}
							stale={stale}
							submissionError={submissionError}
							onRefresh={refresh}
							onRestore={(request) => {
								if (admitting.current || pending) return;
								admitting.current = true;
								setSubmissionError(null);
								restore.mutate(request);
							}}
						/>
					) : null}
				</DialogContent>
			</Dialog>
			{operation?.result === null ? (
				<div className="max-w-sm space-y-1 text-sm" role="status">
					<p className="break-all font-mono text-xs">
						{operation.path}
					</p>
					<DirectCommitWatcher
						key={operation.operationId}
						projectId={operation.projectId}
						snapshotId={operation.operationId}
						native
						branch={operation.branch}
						onSettled={settle}
					/>
				</div>
			) : null}
			{!open ? settledStatus : null}
		</div>
	);
}

function RestoreOperationStatus({
	operation,
	result,
	onDismiss,
}: {
	operation: Operation;
	result: SettledCommit;
	onDismiss: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.fileHistory");
	switch (result.kind) {
		case "pull-request":
			return (
				<DirectCommitPullRequestAlert
					projectId={operation.projectId}
					snapshotId={operation.operationId}
					branch={operation.branch}
					reason={result.reason}
					onDismiss={onDismiss}
				/>
			);
		case "committed":
			return t("committed", { sha: result.sha });
		case "failed":
			return t("failed", { code: result.code });
		case "unchanged":
		case "branch-moved":
		case "rejected":
			return t(result.kind);
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
}
