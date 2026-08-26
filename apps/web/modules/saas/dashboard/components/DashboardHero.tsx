"use client";

import { IncidentChip } from "@saas/shared/components/IncidentChip";
import { getRandomGreeting } from "@saas/shared/lib/greetings";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	CalendarIcon,
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export type TimeRange = "today" | "7d" | "30d" | "90d" | "all";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
	today: "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	all: "All time",
};

interface DashboardHeroProps {
	userName?: string;
	organizationName?: string;
	brandColor?: string;
	timeRange?: TimeRange;
	onTimeRangeChange?: (range: TimeRange) => void;
	onRefresh?: () => void;
}

export function DashboardHero({
	userName,
	organizationName,
	timeRange = "7d",
	onTimeRangeChange,
	onRefresh,
}: DashboardHeroProps) {
	const firstName = userName?.split(" ")[0];
	const [greeting, setGreeting] = useState("");

	// Set after mount to avoid SSR/client hydration mismatch
	useEffect(() => {
		if (firstName) {
			setGreeting(getRandomGreeting(firstName));
		} else if (!organizationName) {
			setGreeting(getRandomGreeting("there"));
		}
	}, [firstName, organizationName]);

	const title = greeting || organizationName || "";

	const subtitle = organizationName
		? "Track your team's progress and collaboration in real-time."
		: "Here are the latest insights from your projects and agents.";

	const handleCopyLink = useCallback(() => {
		navigator.clipboard.writeText(window.location.href);
	}, []);

	return (
		<div className="flex items-start justify-between gap-4">
			<div>
				<h1
					className="text-[1.85rem] tracking-tight text-foreground/90 sm:text-[2.15rem]"
					style={{
						fontFamily:
							"var(--font-sans, 'EB Garamond', Georgia, serif)",
						fontWeight: 400,
					}}
				>
					{title}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground/90 sm:text-[0.95rem]">
					{subtitle}
				</p>
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{/* Active-incident chip (system admins only) — docked to the
				 * LEFT of the range picker. Self-gates to `null` when there is
				 * nothing to show, so it adds no width in the common case. */}
				<IncidentChip />
				{/* Time range picker */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							className="gap-1.5 h-8 text-xs font-medium"
						>
							<CalendarIcon className="h-3.5 w-3.5" />
							{TIME_RANGE_LABELS[timeRange]}
							<ChevronDownIcon className="h-3 w-3 text-muted-foreground" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						<DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
							Date range
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{(
							Object.entries(TIME_RANGE_LABELS) as [
								TimeRange,
								string,
							][]
						).map(([value, label]) => (
							<DropdownMenuItem
								key={value}
								onClick={() => onTimeRangeChange?.(value)}
								className="flex items-center justify-between text-xs"
							>
								{label}
								{timeRange === value && (
									<CheckIcon className="h-3.5 w-3.5 text-primary" />
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>

				{/* Actions menu */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" className="h-8 w-8">
							<MoreHorizontalIcon className="h-4 w-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem
							onClick={onRefresh}
							className="text-xs gap-2"
						>
							<RefreshCwIcon className="h-3.5 w-3.5" />
							Refresh data
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={handleCopyLink}
							className="text-xs gap-2"
						>
							<CopyIcon className="h-3.5 w-3.5" />
							Copy dashboard link
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
