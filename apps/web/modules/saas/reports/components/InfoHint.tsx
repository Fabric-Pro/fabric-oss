"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A small, accessible "(i)" info affordance. Renders an icon button that reveals
 * a short explanation on hover AND keyboard focus (Radix Tooltip), so it is
 * reachable for keyboard + screen-reader users — unlike a bare `title`.
 *
 * Use it inline next to a field label or section heading to explain the more
 * technical concepts without cluttering the form with permanent helper text.
 */
export function InfoHint({
	content,
	label,
	side = "top",
	className,
	iconClassName,
}: {
	/** The explanation shown in the tooltip. */
	content: ReactNode;
	/** Accessible name for the trigger (what the icon is about). */
	label: string;
	side?: "top" | "right" | "bottom" | "left";
	className?: string;
	iconClassName?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={`${label} — more information`}
					className={cn(
						"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
						className,
					)}
				>
					<InfoIcon
						className={cn("size-3.5", iconClassName)}
						aria-hidden
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent
				side={side}
				surface="popover"
				className="max-w-[16rem] text-pretty leading-relaxed"
			>
				{content}
			</TooltipContent>
		</Tooltip>
	);
}
