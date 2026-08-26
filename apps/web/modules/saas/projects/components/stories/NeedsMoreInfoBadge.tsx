import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HelpCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

interface NeedsMoreInfoBadgeProps {
	// "card" matches the compact sizing on roadmap/kanban cards.
	// "detail" is the larger sizing used on the story detail page.
	size?: "card" | "detail";
	tooltip: ReactNode;
}

export function NeedsMoreInfoBadge({
	size = "card",
	tooltip,
}: NeedsMoreInfoBadgeProps) {
	const sizing =
		size === "detail"
			? "px-2 py-0.5 text-[11px]"
			: "px-1.5 py-0.5 text-[10px]";

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 font-medium text-highlight-foreground dark:text-muted-foreground ${sizing}`}
						aria-label="This bug needs more info"
					>
						<HelpCircleIcon className="size-3" aria-hidden />
						Needs More Info
					</span>
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
