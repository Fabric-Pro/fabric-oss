"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { InfoIcon } from "lucide-react";

/**
 * The "what am I looking at" affordance for one heading or control.
 *
 * A tooltip rather than always-on prose: this is reference text a reader wants
 * once and then never again, and permanent explanation above a working list is
 * the thing people learn to scroll past. It sits beside the thing it explains,
 * so the answer is where the question gets asked.
 *
 * Distinct from `SegmentAbout`, which explains a whole segment from the tab bar.
 * This explains one panel, column or control inside it.
 *
 * A `<button>`, not a bare icon: a tooltip that only opens on hover is unusable
 * by keyboard and invisible to touch. Focus opens this one, and it is in the tab
 * order.
 */
export function SectionHint({
	label,
	body,
	className,
}: {
	/** Names what is being explained, for the accessible name. */
	label: string;
	body: string;
	className?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					// 24px hit area around a 14px icon, pulled back with a
					// negative margin so it costs no layout. The icon alone gave
					// a 14×14 target — under the 24×24 minimum, and a genuinely
					// hard thing to hit on a phone.
					className={cn(
						"-m-[5px] inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
				>
					<InfoIcon className="size-3.5" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs leading-relaxed">
				{body}
			</TooltipContent>
		</Tooltip>
	);
}
