"use client";

import type { StoryKind } from "@repo/database";
import { PromptSelector } from "@saas/prompts/components/PromptSelector";
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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	Loader2Icon,
	ShieldCheckIcon,
	SparklesIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { FeatureDraftingStage } from "../../lib/stories/types";
import { DRAFTING_STAGE_META } from "../../lib/stories/types";
import { DraftingStageIndicator } from "./DraftingStageIndicator";
import { useStoryReadiness } from "./useStoryReadiness";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentStage: FeatureDraftingStage;
	targetStage: FeatureDraftingStage;
	/** Story kind — drives prompt selector filtering so bugs don't see
	 *  feature prompts at shared stages (PLACEHOLDER/DRAFT). */
	storyKind: StoryKind;
	featureIdentifier: string;
	featureTitle: string;
	onEnhance: (targetStage: FeatureDraftingStage, promptId?: string) => void;
	isEnhancing?: boolean;
	/**
	 * The project works test-first and this feature has no test cases yet.
	 *
	 * Warned about here, and only when moving to PUBLISHED, because that is the
	 * transition after which somebody starts building. Every other stage move
	 * gets nothing: a dialog that objects to every transition is one people
	 * learn to dismiss without reading, which costs more than it saves.
	 */
	tddNeedsTestCases?: boolean;
	/**
	 * When provided together with "storyId", the dialog fetches readiness
	 * and shows the gaps for a PUBLISHED target (plan Slice 5). Optional so
	 * existing callers keep working.
	 */
	projectId?: string;
	storyId?: string;
	organizationId?: string | null;
	storyVersion?: number | null;
};

export function FeatureTransitionDialog({
	open,
	onOpenChange,
	currentStage,
	targetStage,
	storyKind,
	featureIdentifier,
	featureTitle,
	onEnhance,
	isEnhancing = false,
	tddNeedsTestCases = false,
	projectId,
	storyId,
	organizationId,
	storyVersion,
}: Props) {
	const targetMeta = DRAFTING_STAGE_META[targetStage];
	const [selectedPromptId, setSelectedPromptId] = useState<
		string | undefined
	>();
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const tStories = useTranslations("tooltips.stories");
	const tReadiness = useTranslations("projects.stories.readiness");

	const showReadiness =
		targetStage === "PUBLISHED" && !!projectId && !!storyId;
	const { data: readiness, isPending: readinessPending } = useStoryReadiness({
		projectId: projectId ?? "",
		storyId: storyId ?? "",
		organizationId,
		version: storyVersion,
		enabled: showReadiness && open,
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent ref={dialogContentRef} className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Feature Drafting Transition</DialogTitle>
					<DialogDescription>
						Enhance {featureIdentifier}: {featureTitle}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					{/* Test-first, moving to the stage after which somebody
					    starts building, and nothing exists to build against.
					    Said here rather than as a separate confirmation step:
					    the person is already looking at a dialog about this
					    exact transition, so it lands in context instead of
					    interrupting twice. It informs rather than blocks —
					    moving a feature forward is a planning decision, and
					    what it must not do is start an implementation, which
					    the coding-run gate refuses separately. */}
					{tddNeedsTestCases && targetStage === "PUBLISHED" && (
						<Alert variant="warning">
							<TriangleAlertIcon aria-hidden="true" />
							<AlertTitle>No test cases yet</AlertTitle>
							<AlertDescription>
								This project works test-first. You can move the
								feature on, but Fabric will not start an
								implementation session for it until it has at
								least one test case.
							</AlertDescription>
						</Alert>
					)}

					{/* Stage transition display */}
					<div className="flex items-end gap-3">
						<div>
							<p className="mb-1.5 text-xs text-muted-foreground">
								From
							</p>
							<DraftingStageIndicator
								stage={currentStage}
								compact
							/>
						</div>
						<span className="mb-0.5 text-muted-foreground">
							&rarr;
						</span>
						<div>
							<p className="mb-1.5 text-xs text-muted-foreground">
								To
							</p>
							<DraftingStageIndicator
								stage={targetStage}
								compact
							/>
						</div>
					</div>

					{/* Readiness gaps for Ready for Dev (plan §1.1 / Slice 5) */}
					{showReadiness && (
						<section
							aria-label={tReadiness("transition.gapsTitle")}
							className="rounded-md border border-border/70 bg-muted/40 px-3 py-2.5 text-xs"
						>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span className="inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
									<span
										aria-hidden="true"
										className="inline-block h-3 w-px bg-primary"
									/>
									{tReadiness("transition.gapsTitle")}
								</span>
								{readiness?.reviewRequired && (
									<span
										className="inline-flex items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 px-2 py-0.5 text-[11px] text-highlight"
										title={tReadiness("reviewRequiredHint")}
									>
										<ShieldCheckIcon
											className="size-3"
											aria-hidden="true"
										/>
										{tReadiness("reviewRequired")}
									</span>
								)}
							</div>
							{readinessPending ? (
								<p className="mt-1.5 text-muted-foreground">
									{tReadiness("loading")}
								</p>
							) : !readiness ? (
								<p className="mt-1.5 inline-flex items-center gap-1.5 text-destructive">
									<AlertCircleIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{tReadiness("gaps.EVIDENCE_UNAVAILABLE")}
								</p>
							) : (
								<div className="mt-1.5 space-y-1.5">
									{readiness.missing.length > 0 ? (
										<div>
											<p className="text-foreground">
												{tReadiness(
													"transition.willBlock",
												)}
											</p>
											<ul className="mt-1 space-y-0.5">
												{readiness.missing.map(
													(gap) => (
														<li
															key={gap}
															className="inline-flex items-center gap-1.5 pr-4 text-foreground"
														>
															<span
																aria-hidden="true"
																className="inline-block size-1.5 rounded-full bg-destructive"
															/>
															{tReadiness(
																`gaps.${gap}`,
															)}
														</li>
													),
												)}
											</ul>
										</div>
									) : (
										<p className="inline-flex items-center gap-1.5 text-secondary">
											<CheckCircle2Icon
												className="size-3.5"
												aria-hidden="true"
											/>
											{tReadiness("transition.allClear")}
										</p>
									)}
									{readiness.advisory.length > 0 && (
										<div>
											<p className="text-muted-foreground">
												{tReadiness(
													"transition.advisoryOnly",
												)}
											</p>
											<ul className="mt-1 space-y-0.5">
												{readiness.advisory.map(
													(gap) => (
														<li
															key={gap}
															className="inline-flex items-center gap-1.5 pr-4 text-muted-foreground"
														>
															<span
																aria-hidden="true"
																className="inline-block size-1.5 rounded-full bg-highlight"
															/>
															{tReadiness(
																`gaps.${gap}`,
															)}
														</li>
													),
												)}
											</ul>
										</div>
									)}
								</div>
							)}
						</section>
					)}

					{/* Prompt selector */}
					<div className="space-y-1.5">
						<p className="text-xs text-muted-foreground">Prompt</p>
						<PromptSelector
							agentName="project_document_generator"
							documentType={targetStage}
							storyKind={storyKind}
							value={selectedPromptId}
							onValueChange={setSelectedPromptId}
							disabled={isEnhancing}
							placeholder="Use default prompt"
							showBindAction
							tooltipCollisionBoundaryRef={dialogContentRef}
						/>
					</div>

					<p className="text-xs text-muted-foreground">
						{targetMeta.description}
					</p>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isEnhancing}
					>
						Cancel
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={() =>
									onEnhance(targetStage, selectedPromptId)
								}
								disabled={isEnhancing}
							>
								{isEnhancing ? (
									<>
										<Loader2Icon className="mr-2 size-4 animate-spin" />
										Enhancing...
									</>
								) : (
									<>
										<SparklesIcon className="mr-2 size-4" />
										Enhance
									</>
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tStories("featureTransitionConfirm")}
						</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
