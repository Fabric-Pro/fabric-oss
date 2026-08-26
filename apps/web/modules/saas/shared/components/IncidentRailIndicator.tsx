"use client";

/**
 * Sidebar incident indicator.
 *
 * A small severity-coloured triangle that sits next to the notification bell
 * in the sidebar footer (`SidebarControlsFooter`). Unlike the dashboard
 * `IncidentChip`, this is visible on *every* page (the rail is global) and it
 * survives the 72px collapsed rail used in settings / fullscreen — the parent
 * footer stacks it under the bell when collapsed.
 *
 * The triangle's colour signals severity (red = SEV-1, amber = SEV-2) and a
 * small count badge — styled like the notification bell's unread badge —
 * shows the number of active SEV-1/SEV-2 incidents. The hover / focus tooltip
 * carries the severity breakdown and the incident list. Click navigates to the
 * monitoring dashboard. Like the chip, it self-gates (system admins only) and
 * renders nothing — contributing no pixels — when there is nothing to show.
 *
 * All gating / data / colour logic is shared with the chip via
 * `useIncidentSummary` (`incident-summary.tsx`).
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { AlertTriangleIcon } from "lucide-react";
import { IncidentTooltipBody, useIncidentSummary } from "./incident-summary";

export function IncidentRailIndicator() {
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

	// The aria-label carries the full severity breakdown for assistive tech;
	// the visible count badge (below) mirrors the notification bell so the two
	// rail controls read as a matched pair.
	const ariaLabel = `${heading}. View the monitoring dashboard.`;

	return (
		<TooltipProvider delayDuration={300}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={navigateToMonitoring}
						data-testid="incident-rail-indicator"
						data-tone={paint.tone}
						aria-label={ariaLabel}
						className="relative motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
					>
						<AlertTriangleIcon
							aria-hidden="true"
							className={cn("size-5", paint.iconClass)}
						/>
						{/* Count badge — same shape / size / corner position as
						 * the notification bell's unread badge, so the two rail
						 * controls read as a matched pair. */}
						<Badge
							variant="default"
							className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none tabular-nums"
						>
							{visibleCount > 99 ? "99+" : visibleCount}
						</Badge>
					</Button>
				</TooltipTrigger>
				<TooltipContent
					// `right` reads cleanly in both the wide sidebar and the
					// 72px collapsed rail (the footer sits bottom-left, so the
					// tooltip opens into the content area); `end` anchors it to
					// the icon's bottom so it grows upward, away from the
					// viewport edge.
					side="right"
					align="end"
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
