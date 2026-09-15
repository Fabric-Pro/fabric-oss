"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
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
import { Textarea } from "@ui/components/textarea";
import {
	FlaskConicalIcon,
	GitBranchIcon,
	Loader2Icon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type { ExecutionProvider } from "../../lib/implementation-session-labels";
import { getExecutionProviderLabel } from "../../lib/implementation-session-labels";
import { startSpikeRun } from "../../lib/spike-runs";
import { getReadinessErrorGaps } from "../../lib/stories/readiness";
import type { UserStory } from "../../lib/stories/types";
import { InfoTip } from "./InfoTip";
import { invalidateStoryReadiness } from "./useStoryReadiness";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	story: Pick<UserStory, "id" | "title" | "identifier">;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	implementationDefaultProvider?: ExecutionProvider | null;
	onStarted?: (codingRunId: string) => void;
};

/** Mirrors `codingRuns.start` — `spikeQuestion: z.string().min(10).max(2000)`. */
const QUESTION_MIN_LENGTH = 10;
const QUESTION_MAX_LENGTH = 2000;

/**
 * "Run a spike" — starts a throwaway `SPIKE` coding run that answers a
 * question with a demo and findings instead of a pull request (inverted-loop
 * plan, Slice 3). Available whenever the feature's delivery track is SPIKE;
 * the readiness gate does not apply because the spike is what produces the
 * readiness evidence.
 */
export function RunSpikeDialog({
	open,
	onOpenChange,
	projectId,
	story,
	repositoryOwner,
	repositoryName,
	implementationDefaultProvider,
	onStarted,
}: Props) {
	const t = useTranslations("projects.stories.spike");
	const tTips = useTranslations("tooltips.stories");
	const tReadiness = useTranslations("projects.stories.readiness");
	const { organizationId, basePath } = useOrganizationContext();
	const queryClient = useQueryClient();
	const questionId = useId();
	const [question, setQuestion] = useState(story.title);

	// Prefill from the title each time the dialog opens for a story.
	useEffect(() => {
		if (open) {
			setQuestion(story.title);
		}
	}, [open, story.title]);

	// Preflight: spikes run an AI agent, so an AI provider must be resolvable
	// for this context. Same pattern as feature creation (StoriesRoadmap).
	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () =>
			await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			}),
		enabled: open,
		staleTime: 30_000,
	});
	const isAiNotConfigured =
		!isLoadingAiConfig &&
		aiConfigStatus !== undefined &&
		!aiConfigStatus.isConfigured;
	const aiProviderSettingsUrl = `${basePath}/settings/ai-providers`;

	const hasRepositoryContext = !!repositoryOwner && !!repositoryName;
	const usesLocalProvider = implementationDefaultProvider === "KANBAN_LOCAL";
	const trimmedQuestion = question.trim();
	const questionTooShort =
		trimmedQuestion.length > 0 &&
		trimmedQuestion.length < QUESTION_MIN_LENGTH;
	const questionTooLong = trimmedQuestion.length > QUESTION_MAX_LENGTH;

	const startMutation = useMutation({
		mutationFn: async () =>
			await startSpikeRun({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				spikeQuestion: trimmedQuestion,
			}),
		onSuccess: async (result) => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.codingRuns.list.key(),
				}),
				queryClient.invalidateQueries({ queryKey: ["codingRun"] }),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.queryKey({
						input: {
							projectId,
							storyId: story.id,
							organizationId,
						},
					}),
				}),
				invalidateStoryReadiness(queryClient, {
					projectId,
					storyId: story.id,
				}),
			]);
			toast.success(t("runSpike.started"), {
				description: t("runSpike.startedDescription"),
			});
			onOpenChange(false);
			onStarted?.(result.codingRunId);
		},
		onError: (error) => {
			const gaps = getReadinessErrorGaps(error);
			if (gaps) {
				toast.error(tReadiness("toasts.notReadyTitle"), {
					description:
						gaps.missing.length > 0
							? gaps.missing
									.map((gap) => tReadiness(`gaps.${gap}`))
									.join(", ")
							: error.message,
				});
				return;
			}
			toast.error(t("runSpike.failed"), { description: error.message });
		},
	});

	const canSubmit =
		trimmedQuestion.length >= QUESTION_MIN_LENGTH &&
		!questionTooLong &&
		hasRepositoryContext &&
		!isLoadingAiConfig &&
		!isAiNotConfigured &&
		!startMutation.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[600px]">
				<DialogHeader className="flex-shrink-0 space-y-4 text-left">
					<div className="flex items-start gap-3">
						<div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
							<FlaskConicalIcon className="size-5 text-primary" />
						</div>
						<div className="min-w-0 flex-1 space-y-2 pr-8">
							<Badge
								variant="outline"
								className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.16em] text-primary"
							>
								{t("kindBadge")}
							</Badge>
							<DialogTitle className="text-xl leading-tight sm:text-2xl">
								<span className="inline-flex items-center gap-2">
									{t("runSpike.title")}
									<InfoTip label={tTips("spikeRunHelp")}>
										<p>{tTips("spikeRun")}</p>
									</InfoTip>
								</span>
							</DialogTitle>
							<DialogDescription className="max-w-[60ch] text-sm leading-6">
								{t("runSpike.description")}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<form
					className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1 pr-1"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSubmit) {
							startMutation.mutate();
						}
					}}
				>
					{isAiNotConfigured && (
						<Alert variant="error">
							<AlertTitle>
								{t("runSpike.aiNotConfiguredTitle")}
							</AlertTitle>
							<AlertDescription className="flex flex-wrap items-center gap-2">
								<span>{t("runSpike.aiNotConfigured")}</span>
								<Button asChild variant="outline" size="sm">
									<Link href={aiProviderSettingsUrl}>
										<SettingsIcon className="mr-1.5 size-3.5" />
										{t("runSpike.openAiSettings")}
									</Link>
								</Button>
							</AlertDescription>
						</Alert>
					)}

					{!hasRepositoryContext && (
						<div className="rounded-2xl border border-highlight/30 bg-highlight/5 p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								{t("runSpike.repositoryRequiredTitle")}
							</p>
							<p className="mt-2 text-sm leading-6 text-foreground/85">
								{t("runSpike.repositoryRequired")}
							</p>
						</div>
					)}

					{usesLocalProvider && (
						<div className="rounded-2xl border border-border/60 bg-muted/40 p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								{t("runSpike.providerHintTitle")}
							</p>
							<p className="mt-2 text-sm leading-6 text-foreground/85">
								{t("runSpike.providerHint", {
									local: getExecutionProviderLabel(
										"KANBAN_LOCAL",
									),
									background:
										getExecutionProviderLabel(
											"BACKGROUND_AGENTS",
										),
								})}
							</p>
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor={questionId}>
							{t("runSpike.questionLabel")}
						</Label>
						<Textarea
							id={questionId}
							value={question}
							onChange={(event) =>
								setQuestion(event.target.value)
							}
							rows={4}
							maxLength={QUESTION_MAX_LENGTH + 1}
							placeholder={t("runSpike.questionPlaceholder")}
							aria-invalid={
								questionTooShort || questionTooLong || undefined
							}
							className="resize-none text-sm"
						/>
						<p
							className={
								questionTooShort || questionTooLong
									? "text-xs leading-5 text-destructive"
									: "text-xs leading-5 text-muted-foreground"
							}
						>
							{questionTooShort
								? t("runSpike.questionTooShort", {
										min: QUESTION_MIN_LENGTH,
									})
								: questionTooLong
									? t("runSpike.questionTooLong", {
											max: QUESTION_MAX_LENGTH,
										})
									: t("runSpike.questionHint")}
						</p>
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="rounded-2xl border border-border/60 bg-background p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								{t("runSpike.featureLabel")}
							</p>
							<p className="mt-2 truncate text-sm font-medium text-foreground">
								<span className="mr-2 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
									{story.identifier}
								</span>
								{story.title}
							</p>
						</div>
						<div className="rounded-2xl border border-border/60 bg-background p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								{t("runSpike.repositoryLabel")}
							</p>
							<p className="mt-2 flex items-center gap-2 text-sm font-medium text-foreground">
								<GitBranchIcon className="size-4 text-primary" />
								<span className="truncate">
									{hasRepositoryContext
										? `${repositoryOwner}/${repositoryName}`
										: t("runSpike.noRepository")}
								</span>
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("runSpike.branchHint")}
							</p>
						</div>
					</div>

					<DialogFooter className="flex-shrink-0 gap-2 pt-2 sm:justify-between">
						<p className="text-xs leading-5 text-muted-foreground sm:max-w-[55ch]">
							{t("runSpike.footerNote")}
						</p>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={startMutation.isPending}
							>
								{t("cancel")}
							</Button>
							<Button type="submit" disabled={!canSubmit}>
								{startMutation.isPending ? (
									<>
										<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
										{t("runSpike.starting")}
									</>
								) : (
									t("runSpike.submit")
								)}
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
