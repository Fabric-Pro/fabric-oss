"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { HelpCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Icon-only "what is this?" trigger used beside labels, headings and
 * options introduced by the delivery-track work. Keyboard reachable, named
 * for screen readers through `label` (CLAUDE.md a11y rule), and rendered
 * with the same Tooltip primitives the roadmap already uses.
 */
export function InfoTip({
	label,
	children,
	className,
	side,
}: {
	/** Accessible name of the trigger, e.g. "About delivery tracks". */
	label: string;
	children: ReactNode;
	className?: string;
	side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className={cn(
						"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
				>
					<HelpCircleIcon className="size-3.5" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side={side} className="max-w-xs text-xs leading-5">
				{children}
			</TooltipContent>
		</Tooltip>
	);
}
