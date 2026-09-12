"use client";

import { IncidentChip } from "@saas/shared/components/IncidentChip";
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
	/*
	 * The workspace name and the date, in place of the rotating salutation
	 * and its emoji: a page header says where you are, not how it feels.
	 */
	const title =
		organizationName ||
		(userName ? `${userName.split(" ")[0]}'s workspace` : "Your workspace");
	const [today, setToday] = useState("");
	useEffect(() => {
		setToday(
			new Date().toLocaleDateString(undefined, {
				weekday: "long",
				day: "numeric",
				month: "long",
			}),
		);
	}, []);
	const subtitle = today;

	const handleCopyLink = useCallback(() => {
		navigator.clipboard.writeText(window.location.href);
	}, []);

	return (
		<div className="flex items-start justify-between gap-4">
			<div>
				<h1 className="text-[1.6rem] tracking-[-0.025em] text-foreground sm:text-[1.9rem]">
					{title}
				</h1>
				<p className="fab-label mt-2">{subtitle}</p>
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
