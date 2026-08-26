"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { InfoIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MAX_FEATURES_PER_DRAFT_JOB } from "./draft-jobs";
import { FeaturePicker } from "./FeaturePicker";
import { TestCaseDraftJobWatcher } from "./TestCaseDraftJobWatcher";

type Props = {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * "Generate test cases with AI" — pick one or more features, start a background
 * run that drafts editable DRAFT cases from their acceptance criteria.
 *
 * The dialog closes the instant the run starts. Drafting is a chain of LLM calls
 * that outlives the page: it runs in a workflow, the job row is the source of
 * truth, and progress/completion come back through the watcher below (which stays
 * mounted after this dialog closes) and a notification. Advisory by design — a
 * project with no AI provider gets a soft hint from the run's results, not an
 * error.
 */
export function AiDraftDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const [storyIds, setStoryIds] = useState<string[]>([]);

	useEffect(() => {
		if (open) {
			setStoryIds([]);
		}
	}, [open]);

	const startMutation = useMutation(
		orpc.projects.testCases.aiDraft.mutationOptions({
			onSuccess: () => {
				// Hand off to the watcher: it polls the job row, so it needs the
				// list to know a new run exists.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.draftJobs.list.key(),
				});
				onOpenChange(false);
			},
			onError: (e) =>
				toast.error(t("toasts.draftFailed", { error: e.message })),
		}),
	);

	const atCap = storyIds.length >= MAX_FEATURES_PER_DRAFT_JOB;

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<SparklesIcon
								className="size-5 text-primary"
								aria-hidden="true"
							/>
							{t("ai.draftTitle")}
						</DialogTitle>
						<DialogDescription>
							{t("ai.draftHint")}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="ai-draft-feature">
								{t("ai.features")}
							</Label>
							<FeaturePicker
								projectId={projectId}
								organizationId={organizationId}
								value={storyIds}
								multiple
								onChange={(selected) =>
									setStoryIds(
										selected
											.slice(
												0,
												MAX_FEATURES_PER_DRAFT_JOB,
											)
											.map((option) => option.id),
									)
								}
								triggerId="ai-draft-feature"
								ariaLabel={t("ai.featureAria")}
								placeholder={t("ai.featurePlaceholder")}
							/>
							{/* The cap is a spend limit — each feature is a
							    separate generation — so it is stated up front
							    rather than silently trimming the selection. */}
							<p
								className="text-muted-foreground text-xs"
								aria-live="polite"
							>
								{atCap
									? t("ai.capReached", {
											max: MAX_FEATURES_PER_DRAFT_JOB,
										})
									: t("ai.capHint", {
											max: MAX_FEATURES_PER_DRAFT_JOB,
										})}
							</p>
						</div>

						<div className="flex items-start gap-2 rounded-lg border bg-muted p-3 text-sm">
							<InfoIcon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden="true"
							/>
							<p className="text-foreground/90">
								{t("ai.backgroundHint")}
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={startMutation.isPending}
						>
							{t("actions.cancel")}
						</Button>
						<Button
							onClick={() =>
								startMutation.mutate({
									projectId,
									storyIds,
									organizationId,
								})
							}
							disabled={
								storyIds.length === 0 || startMutation.isPending
							}
						>
							{startMutation.isPending && (
								<Loader2Icon
									aria-hidden="true"
									className="mr-2 size-4 motion-safe:animate-spin"
								/>
							)}
							{t("actions.generateWithAi")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Outlives the dialog on purpose: the run keeps going after this
			    closes, and after a reload the watcher is what re-finds it. */}
			<TestCaseDraftJobWatcher
				projectId={projectId}
				organizationId={organizationId}
			/>
		</>
	);
}
