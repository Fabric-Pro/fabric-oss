"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import type { FeatureDraftingStage } from "../../lib/stories/types";
import { DRAFTING_STAGE_META } from "../../lib/stories/types";

type Props = {
	stage: FeatureDraftingStage;
	compact?: boolean;
};

const ORDERED_STAGES: FeatureDraftingStage[] = [
	"PLACEHOLDER",
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
	"DRAFT",
	"PUBLISHED",
];

const TERMINAL_STAGES: FeatureDraftingStage[] = ["DECLINED", "CLOSED"];

export function DraftingStageIndicator({ stage, compact = false }: Props) {
	const meta = DRAFTING_STAGE_META[stage];
	if (!meta) {
		return null;
	}

	const isTerminal = TERMINAL_STAGES.includes(stage);
	const useTokens = stage === "CLOSED";

	if (compact || isTerminal) {
		const chipClass = useTokens
			? "inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
			: "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium";
		const chipStyle = useTokens
			? undefined
			: {
					backgroundColor: `${meta.color}20`,
					color: meta.color,
				};
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span className={chipClass} style={chipStyle}>
						{meta.label}
					</span>
				</TooltipTrigger>
				<TooltipContent>
					<p className="font-medium">{meta.label}</p>
					<p className="text-xs text-muted-foreground">
						{meta.description}
					</p>
				</TooltipContent>
			</Tooltip>
		);
	}

	const currentOrder = meta.order;
	const totalStages = ORDERED_STAGES.length;

	return (
		<div className="flex items-center gap-2">
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="flex items-center gap-2">
						{/* Progress bar */}
						<div className="flex gap-0.5">
							{ORDERED_STAGES.map((s) => {
								const sMeta = DRAFTING_STAGE_META[s];
								const isActive = sMeta.order <= currentOrder;
								return (
									<div
										key={s}
										className="h-1.5 w-4 rounded-full transition-colors"
										style={{
											backgroundColor: isActive
												? meta.color
												: `${meta.color}20`,
										}}
									/>
								);
							})}
						</div>
						{/* Label */}
						<span
							className="text-xs font-medium"
							style={{ color: meta.color }}
						>
							{meta.label}
						</span>
					</div>
				</TooltipTrigger>
				<TooltipContent>
					<p className="font-medium">Drafting Stage: {meta.label}</p>
					<p className="text-xs text-muted-foreground">
						{meta.description}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Stage {currentOrder + 1} of {totalStages}
					</p>
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
