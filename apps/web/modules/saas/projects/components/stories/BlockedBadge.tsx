import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { OctagonXIcon } from "lucide-react";
import type { ReactNode } from "react";

interface BlockedBadgeProps {
	// "card" matches the compact sizing on roadmap/kanban cards.
	// "detail" is the larger sizing used on the story detail page.
	size?: "card" | "detail";
	tooltip: ReactNode;
}

export function BlockedBadge({ size = "card", tooltip }: BlockedBadgeProps) {
	const sizing =
		size === "detail"
			? "px-2 py-0.5 text-[11px]"
			: "px-1.5 py-0.5 text-[10px]";

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 font-medium text-destructive ${sizing}`}
						aria-label="This work item is blocked"
					>
						<OctagonXIcon className="size-3" aria-hidden />
						Blocked
					</span>
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
