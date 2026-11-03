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
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { useState } from "react";
import { toast } from "sonner";

/**
 * "Measure" (spec 2026-10-28 §8b) and "Suggest settings" (§8c) on RAG
 * Settings. Both first show the bounded cost and run only after the person
 * confirms; neither changes the project. Their results show in the per-type
 * table, where a suggestion is applied only by an explicit Apply, which
 * re-chunks the project.
 */

type Mode = "MEASURE" | "TUNE";

interface Estimate {
	sampledSources: number;
	questions: number;
	embeddingCalls: number;
}

/**
 * Starts a measure or a suggestion: `ask` reads the bounded cost, `dialog`
 * asks the person to confirm it. Shared by the RAG Settings buttons and the
 * chunking-check prompt.
 */
export function useChunkingAnalysis(projectId: string) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<{
		runId: string;
		mode: Mode;
		estimate: Estimate;
	} | null>(null);
	const runsKey = orpc.projects.ragSettings.chunkingRuns.queryKey({
		input: { projectId },
	});
	const refresh = () => queryClient.invalidateQueries({ queryKey: runsKey });

	const start = useMutation(
		orpc.projects.ragSettings.startChunkingAnalysis.mutationOptions({
			onError: (error) => toast.error(error.message),
		}),
	);
	const confirm = useMutation(
		orpc.projects.ragSettings.confirmChunkingAnalysis.mutationOptions({
			onSuccess: () => {
				toast.success("Analysis started");
				refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const ask = (mode: Mode) =>
		start.mutate(
			{ projectId, mode },
			{
				onSuccess: (result) =>
					setPending({
						runId: result.runId,
						mode,
						estimate: result.estimate,
					}),
			},
		);

	const dialog = (
		<AlertDialog
			open={pending !== null}
			onOpenChange={(open) => !open && setPending(null)}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{pending?.mode === "TUNE"
							? "Suggest chunking settings?"
							: "Measure chunking?"}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-2 text-sm">
							<p>
								Fabric samples this project's content, writes
								test questions with your organization's model,
								and checks how often search finds the answer.
								Nothing in the project changes.
							</p>
							{pending && (
								<ul className="list-disc space-y-1 pl-5">
									<li>
										{pending.estimate.sampledSources.toLocaleString()}{" "}
										sources sampled
									</li>
									<li>
										About{" "}
										{pending.estimate.questions.toLocaleString()}{" "}
										questions
									</li>
									<li>
										About{" "}
										{pending.estimate.embeddingCalls.toLocaleString()}{" "}
										embedding calls
									</li>
								</ul>
							)}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							if (pending) {
								confirm.mutate({
									projectId,
									runId: pending.runId,
								});
							}
							setPending(null);
						}}
					>
						Run
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);

	return { ask, starting: start.isPending, dialog };
}

export function ChunkingAnalysisActions({ projectId }: { projectId: string }) {
	const { ask, starting, dialog } = useChunkingAnalysis(projectId);
	return (
		<div className="flex items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				disabled={starting}
				onClick={() => ask("MEASURE")}
			>
				Measure
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={starting}
				onClick={() => ask("TUNE")}
			>
				Suggest settings
			</Button>
			{dialog}
		</div>
	);
}
