import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BlocksIcon,
	MessageSquareIcon,
	PencilIcon,
	SparklesIcon,
} from "lucide-react";
import { STORY_SOURCE_LABELS } from "../../lib/roadmap-filters";
import type { StorySource } from "../../lib/stories/types";

/** Icon per source family so the chip reads as a provenance/source at a glance:
 * AI-generated, chat, an external PM/integration tool, or hand-entered. Exported
 * so the source FILTER can show the same icon per option. */
export function sourceIcon(source: StorySource) {
	switch (source) {
		case "ai_update":
		case "custom_agent":
		case "approved_proposal":
			return SparklesIcon;
		case "slack":
			return MessageSquareIcon;
		case "manual":
			return PencilIcon;
		default:
			// jira, azure_devops, fizzy, gitlab, linear, github
			return BlocksIcon;
	}
}

/** The provenance chip — a source icon + the source name, with the full label
 * in a tooltip. Shared by the table row and the board tile. */
export function SourceChip({
	source,
	className,
}: {
	source: StorySource;
	className?: string;
}) {
	const label = STORY_SOURCE_LABELS[source];
	const Icon = sourceIcon(source);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-1.5 py-0.5 font-medium text-muted-foreground/80",
						className,
					)}
				>
					<Icon className="size-3 shrink-0 text-muted-foreground/60" />
					<span className="truncate">{label}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>Source — {label}</TooltipContent>
		</Tooltip>
	);
}
