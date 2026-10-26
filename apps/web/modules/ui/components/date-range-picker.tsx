"use client";

import { Button } from "@ui/components/button";
import { Calendar } from "@ui/components/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { format, startOfDay, startOfMonth, subDays } from "date-fns";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

export type DateRangeValue = { from?: Date | string; to?: Date | string };
type DateRangeSelection = { from?: Date; to?: Date };
export type DateRangePreset = {
	label: string;
	getRange: (today: Date) => DateRangeValue;
};
// Shared UI receives translated copy from its caller, without requiring intl context.
export type DateRangePickerLabels = {
	any: string;
	clear: string;
	from: (date: string) => string;
	until: (date: string) => string;
	lastDays: (days: number) => string;
	thisMonth: string;
};

function asDate(value: Date | string | undefined): Date | undefined {
	if (!value) {
		return undefined;
	}
	// Date-only filter values denote local calendar days, not UTC instants.
	const date =
		value instanceof Date
			? value
			: new Date(
					/^\d{4}-\d{2}-\d{2}$/.test(value)
						? `${value}T00:00:00`
						: value,
				);
	return Number.isNaN(date.getTime()) ? undefined : date;
}
function rangeText(
	{ from, to }: DateRangeSelection,
	labels: DateRangePickerLabels,
): string {
	if (from && to) {
		const start = format(
			from,
			from.getFullYear() === to.getFullYear() ? "MMM d" : "MMM d, yyyy",
		);
		return `${start} – ${format(to, "MMM d, yyyy")}`;
	}
	if (from) {
		return labels.from(format(from, "MMM d, yyyy"));
	}
	if (to) {
		return labels.until(format(to, "MMM d, yyyy"));
	}
	return labels.any;
}

export function DateRangePicker({
	value,
	onChange,
	label,
	labels,
	presets,
	disabled,
	className,
}: {
	value: DateRangeValue;
	onChange: (next: DateRangeSelection) => void;
	label: string;
	labels: DateRangePickerLabels;
	presets?: DateRangePreset[];
	disabled?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	// Two calendar months plus presets need more room than the sm breakpoint.
	const [showTwoMonths, setShowTwoMonths] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(min-width: 768px)");
		const update = () => setShowTwoMonths(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const selected = { from: asDate(value.from), to: asDate(value.to) };
	const text = `${label}: ${rangeText(selected, labels)}`;
	const options = presets ?? [
		...[7, 30, 90].map((days) => ({
			label: labels.lastDays(days),
			getRange: (today: Date) => ({
				from: subDays(today, days - 1),
				to: today,
			}),
		})),
		{
			label: labels.thisMonth,
			getRange: (today: Date) => ({
				from: startOfMonth(today),
				to: today,
			}),
		},
	];
	function apply(next: DateRangeValue) {
		onChange({ from: asDate(next.from), to: asDate(next.to) });
		setOpen(false);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					title={open ? undefined : text}
					className={cn(
						"inline-flex h-9 w-40 shrink-0 items-center justify-between gap-1.5 border-border bg-transparent px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
						(selected.from || selected.to) &&
							"border-primary/50 bg-primary/10 text-primary",
						className,
					)}
				>
					<span className="truncate">{text}</span>
					<ChevronDownIcon
						aria-hidden
						className="size-3.5 shrink-0 opacity-70"
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				collisionPadding={16}
				avoidCollisions
				align="start"
				aria-label={label}
				className="flex w-auto max-w-[min(calc(100vw-2rem),var(--radix-popover-content-available-width))] flex-col overflow-x-auto p-0 sm:flex-row"
			>
				<div className="flex flex-wrap gap-1 border-border border-b p-2 sm:w-36 sm:flex-col sm:border-r sm:border-b-0">
					{options.map((preset) => (
						<Button
							type="button"
							key={preset.label}
							variant="ghost"
							size="sm"
							className="justify-start text-xs"
							onClick={() =>
								apply(preset.getRange(startOfDay(new Date())))
							}
						>
							{preset.label}
						</Button>
					))}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="justify-start text-xs"
						onClick={() => apply({})}
					>
						{labels.clear}
					</Button>
				</div>
				<Calendar
					mode="range"
					numberOfMonths={showTwoMonths ? 2 : 1}
					showOutsideDays={false}
					defaultMonth={selected.from ?? selected.to}
					selected={selected}
					onSelect={(_range, day) => {
						// A calendar day is already a useful open-ended filter. Selecting an
						// earlier end restarts the range; only completing a range closes it.
						if (
							!selected.from ||
							selected.to ||
							day < selected.from
						) {
							onChange({ from: day, to: undefined });
							return;
						}
						apply({ from: selected.from, to: day });
					}}
					// Radix focuses with preventScroll; calendar autofocus can scroll
					// the page before the floating content has been positioned.
				/>
			</PopoverContent>
		</Popover>
	);
}
