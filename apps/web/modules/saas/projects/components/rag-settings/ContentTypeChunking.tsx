"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
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

/**
 * Content-type chunking on RAG Settings (spec 2026-10-28 §6, §8a): the
 * confirmation a chunking change needs (it re-chunks the whole project), and
 * the latest re-chunk's progress.
 */

function formatNumber(value: number): string {
	return value.toLocaleString();
}

export function RechunkConfirmDialog({
	projectId,
	open,
	onOpenChange,
	onConfirm,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const { data: preview, isLoading } = useQuery({
		...orpc.projects.ragSettings.rechunkPreview.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Re-chunk this project?</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-2 text-sm">
							<p>
								Changing how content is chunked re-chunks every
								source of the project from the text Fabric
								already stores. Search keeps answering from the
								current chunks until each source is done.
							</p>
							{isLoading || !preview ? (
								<p className="text-foreground/50">
									Counting sources…
								</p>
							) : (
								<ul className="list-disc space-y-1 pl-5">
									<li>
										{formatNumber(preview.contexts)} context
										source
										{preview.contexts === 1 ? "" : "s"}
									</li>
									<li>
										{formatNumber(preview.documents)}{" "}
										document
										{preview.documents === 1 ? "" : "s"}
									</li>
									<li>
										About{" "}
										{formatNumber(preview.estimatedTokens)}{" "}
										embedding tokens
									</li>
								</ul>
							)}
							<p className="text-foreground/50 text-xs">
								Code indexed from repositories is not affected.
							</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>
						Save and re-chunk
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

type RunProgress = {
	total?: number;
	done?: number;
	failed?: number;
	skipped?: number;
};

const STATUS_LABEL: Record<string, string> = {
	RUNNING: "Re-chunking",
	COMPLETED: "Last re-chunk finished",
	FAILED: "Last re-chunk failed; the project keeps its previous chunks",
	SUPERSEDED: "Re-chunk replaced by a newer change",
	CANCELLED: "Re-chunk cancelled",
};

export function RechunkStatus({ projectId }: { projectId: string }) {
	const { data } = useQuery({
		...orpc.projects.ragSettings.chunkingRuns.queryOptions({
			input: { projectId },
		}),
		refetchInterval: (query) =>
			query.state.data?.rechunk?.status === "RUNNING" ? 5000 : false,
	});
	const run = data?.rechunk;
	if (!run) {
		return null;
	}
	const progress = (run.progress ?? {}) as RunProgress;
	const total = progress.total ?? 0;
	const finished =
		(progress.done ?? 0) + (progress.failed ?? 0) + (progress.skipped ?? 0);

	return (
		<output className="block text-foreground/60 text-xs">
			{STATUS_LABEL[run.status] ?? run.status}
			{total > 0
				? ` · ${formatNumber(finished)} / ${formatNumber(total)} sources`
				: ""}
			{progress.failed
				? ` · ${formatNumber(progress.failed)} failed`
				: ""}
		</output>
	);
}
