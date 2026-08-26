"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";

interface AlwaysOnPillProps {
	/** Extra classes for size/spacing tuning per host. */
	className?: string;
}

/**
 * Non-actionable "Always on" pill rendered in place of the enable/install
 * controls on managed-default MCP rows (`MCPConfig.isManagedDefault === true`
 * or `MCPServer.defaultEnabled === true`).
 *
 * Stays focusable (`<button aria-disabled>`) so keyboard users can reach
 * the tooltip; accessible name equals the visible label per WCAG 2.5.3.
 * The tooltip carries the longer description via Radix's `aria-describedby`.
 *
 * Consumers MUST be wrapped in a `<TooltipProvider>` (every host already
 * is, so we don't double-wrap here).
 */
export function AlwaysOnPill({ className }: AlwaysOnPillProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-disabled="true"
					data-testid="mcp-always-on-pill"
					className={cn(
						"rounded-sm border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground shrink-0 cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
				>
					Always on
				</button>
			</TooltipTrigger>
			<TooltipContent>
				Enabled for everyone, no setup needed.
			</TooltipContent>
		</Tooltip>
	);
}
