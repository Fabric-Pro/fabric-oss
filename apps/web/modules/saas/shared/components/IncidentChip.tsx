"use client";

/**
 * Dashboard incident chip.
 *
 * Placement history:
 *   - v1 was a full-width `IncidentBanner` across the saas shell.
 *   - v2 was a `fixed` chip docked top-right of the viewport, next to the AI
 *     credits chip. That overlapped the dashboard's own top-right controls
 *     (the "Last 90 days" range picker + the "⋯" actions menu) and the
 *     credits chip, and floated over every page whether or not it belonged
 *     there.
 *   - v3 (this) renders the chip *inline* in the dashboard hero, immediately
 *     to the LEFT of the range picker. It is no longer fixed/sticky — it
 *     scrolls with the hero and only exists on the Start page. The
 *     always-visible signal moved to `IncidentRailIndicator` in the sidebar.
 *
 * Visual treatment (unchanged from v2):
 *      ┌──────────┐
 *      │ ⚠  3     │
 *      └──────────┘
 * - Triangle tone reflects the highest-severity active incident:
 *     - any SEV-1 active → destructive (red)
 *     - SEV-2 only       → highlight (amber)
 *     - SEV-3 only       → not rendered
 * - Click navigates to the monitoring dashboard. The chip is its own
 *   permission gate (system admins only) so the target is always reachable
 *   when visible.
 * - Hover / focus tooltip lists up to 3 incidents, with a "+ N more" tail.
 *
 * All of the gating / data / colour logic lives in `useIncidentSummary`
 * (`incident-summary.tsx`), shared with the sidebar rail indicator.
 */

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { AlertTriangleIcon } from "lucide-react";
import { IncidentTooltipBody, useIncidentSummary } from "./incident-summary";

// Re-exported for callers/tests that imported the role gate from here before
// the logic moved into `incident-summary.tsx`.
export { canViewIncidentChip } from "./incident-summary";

export function IncidentChip() {
	const {
		shouldRender,
		paint,
		visibleCount,
		sev3Count,
		heading,
		enumeratedRows,
		overflowCount,
		navigateToMonitoring,
	} = useIncidentSummary();

	if (!shouldRender) {
		return null;
	}

	const ariaLabel = `${heading}. Click to view the monitoring dashboard.`;

	// `h-8` matches the dashboard hero's outline controls (range picker /
	// actions menu) so the chip aligns cleanly beside them.
	const triggerButton = (
		<button
			type="button"
			onClick={navigateToMonitoring}
			data-testid="incident-chip"
			data-tone={paint.tone}
			aria-label={ariaLabel}
			className={cn(
				"inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
				paint.chipClass,
			)}
		>
			<AlertTriangleIcon
				aria-hidden="true"
				className={cn("size-3.5 shrink-0", paint.iconClass)}
			/>
			<span className="tabular-nums">{visibleCount}</span>
		</button>
	);

	return (
		<TooltipProvider delayDuration={300}>
			<Tooltip>
				<TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
				<TooltipContent
					side="bottom"
					align="end"
					// Incident titles can be long ("Gmail: Gmail Android users
					// using Microsoft Exchange…"); generous max width + word
					// wrap keeps the full title readable.
					className="max-w-sm space-y-2 px-3 py-2 text-xs leading-relaxed"
				>
					<IncidentTooltipBody
						enumeratedRows={enumeratedRows}
						overflowCount={overflowCount}
						sev3Count={sev3Count}
					/>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
