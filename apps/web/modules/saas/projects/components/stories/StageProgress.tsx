import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	DRAFTING_STAGE_META,
	type FeatureDraftingStage,
} from "../../lib/stories/types";

// Features run the full maturation pipeline; bugs have a condensed one (no
// analysis stages). Mirrors the StoryWorkspace editor's `activeStages`.
const FEATURE_STAGES: FeatureDraftingStage[] = [
	"PLACEHOLDER",
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
	"DRAFT",
	"PUBLISHED",
];
const BUG_STAGES: FeatureDraftingStage[] = [
	"PLACEHOLDER",
	"DRAFT",
	"PUBLISHED",
];

/**
 * Read-only drafting-stage indicator: a row of segments (filled up to the
 * current stage, faint beyond) plus the stage label — the same visual the
 * StoryWorkspace editor uses, so the roadmap reads consistently. Segment and
 * label colour come from the current stage's `DRAFTING_STAGE_META.color`; a
 * CLOSED item shows a muted, blanked-out pipeline.
 */
export function StageProgress({
	stage,
	kind,
	className,
}: {
	stage: string;
	kind: string;
	className?: string;
}) {
	const stages = kind === "BUG" ? BUG_STAGES : FEATURE_STAGES;
	const effective =
		DRAFTING_STAGE_META[stage as FeatureDraftingStage] ??
		DRAFTING_STAGE_META.PLACEHOLDER;
	const isClosing = stage === "CLOSED";
	const idx = stages.findIndex((s) => s === stage);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"flex min-w-0 items-center gap-1.5",
						className,
					)}
				>
					<span className="flex shrink-0 gap-0.5">
						{stages.map((s) => {
							const sMeta = DRAFTING_STAGE_META[s];
							const filled =
								!isClosing && sMeta.order <= effective.order;
							return (
								<span
									key={s}
									className="h-1.5 w-3.5 rounded-full transition-colors"
									style={{
										backgroundColor: isClosing
											? "color-mix(in srgb, var(--muted-foreground) 20%, transparent)"
											: filled
												? effective.color
												: `${effective.color}20`,
									}}
								/>
							);
						})}
					</span>
					<span
						className="truncate text-[10px] font-medium"
						style={{
							color: isClosing
								? "var(--muted-foreground)"
								: effective.color,
						}}
					>
						{effective.label}
					</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>
				<p className="font-medium">Stage: {effective.label}</p>
				<p className="text-xs text-muted-foreground">
					{effective.description}
				</p>
				{!isClosing && idx >= 0 && (
					<p className="mt-1 text-xs text-muted-foreground">
						Stage {idx + 1} of {stages.length}
					</p>
				)}
			</TooltipContent>
		</Tooltip>
	);
}
