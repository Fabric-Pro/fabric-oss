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
import { Loader2Icon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { FeatureDraftingStage } from "../../lib/stories/types";
import { DRAFTING_STAGE_META } from "../../lib/stories/types";
import { DraftingStageIndicator } from "./DraftingStageIndicator";

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
}: Props) {
	const targetMeta = DRAFTING_STAGE_META[targetStage];
	const [selectedPromptId, setSelectedPromptId] = useState<
		string | undefined
	>();
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const tStories = useTranslations("tooltips.stories");

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
