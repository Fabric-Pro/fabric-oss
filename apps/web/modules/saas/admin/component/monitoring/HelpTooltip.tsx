"use client";

/**
 * Small `(?)` help tooltip used throughout the monitoring dashboard to
 * explain opaque terms (SEV-1, burn rate, hysteresis, statuspage, synthetic
 * probe, breaker, etc.) inline without crowding the surrounding label.
 *
 * Renders a Radix Tooltip wrapped around a transparent `<button>` with the
 * `HelpCircleIcon`. The button is fully keyboard accessible (Tab focusable,
 * Enter/Space activates the tooltip) and always carries an `aria-label`
 * derived from the `label` prop, so screen readers announce e.g.
 * "What is SEV-1?" before the tooltip text streams in.
 *
 * `prefers-reduced-motion` is respected automatically — Radix Tooltip's
 * `data-state` transitions degrade to plain visibility changes when the
 * media query is set. The icon itself uses no looping animation.
 */

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { HelpCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

export type HelpTooltipProps = {
	/** Short label used to construct the `aria-label` ("What is {label}?"). */
	label: string;
	/** Tooltip body. Can be a plain string or any inline markup. */
	children: ReactNode;
	/**
	 * Override the default size of the icon (defaults to 12px / `size-3`).
	 * Useful when the surrounding text is large (page header) and a 14px
	 * icon reads better.
	 */
	iconClassName?: string;
	/** Max width for the tooltip body. Defaults to ~20rem. */
	contentClassName?: string;
	/** Where the tooltip should appear (defaults to "top"). */
	side?: "top" | "right" | "bottom" | "left";
};

export function HelpTooltip({
	label,
	children,
	iconClassName,
	contentClassName,
	side = "top",
}: HelpTooltipProps) {
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={`What is ${label}?`}
						className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/80 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<HelpCircleIcon
							className={cn("size-3", iconClassName)}
							aria-hidden="true"
						/>
					</button>
				</TooltipTrigger>
				<TooltipContent
					side={side}
					className={cn(
						"max-w-xs text-pretty text-xs leading-relaxed",
						contentClassName,
					)}
				>
					{children}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * Wrap an existing element (typically a label/badge) in a tooltip without
 * adding a separate `(?)` icon. Used for the pill-style status indicators
 * where the entire pill should be the tooltip trigger.
 */
export function InlineTooltip({
	label,
	children,
	content,
	contentClassName,
	side = "top",
}: {
	label: string;
	children: ReactNode;
	content: ReactNode;
	contentClassName?: string;
	side?: "top" | "right" | "bottom" | "left";
}) {
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className="inline-flex cursor-help items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
					>
						{children}
					</button>
				</TooltipTrigger>
				<TooltipContent
					side={side}
					className={cn(
						"max-w-xs text-pretty text-xs leading-relaxed",
						contentClassName,
					)}
				>
					{content}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
