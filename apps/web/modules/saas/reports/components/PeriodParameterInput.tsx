"use client";

import {
	findPeriodPreset,
	formatPeriodRange,
	getPeriodPresets,
	parsePeriodRange,
} from "@saas/reports/lib/date-parameter";
import { Button } from "@ui/components/button";
import {
	DateRangePicker,
	type DateRangePickerLabels,
} from "@ui/components/date-range-picker";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import { useMemo, useState } from "react";

const RANGE_LABELS: DateRangePickerLabels = {
	any: "Pick dates",
	clear: "Clear",
	from: (date) => `From ${date}`,
	until: (date) => `Until ${date}`,
	lastDays: (days) => `Last ${days} days`,
	thisMonth: "This month",
};

type Props = {
	id: string;
	value: string;
	onChange: (value: string) => void;
	schema: { description?: string; default?: unknown };
	placeholder: string;
	required?: boolean;
	invalid?: boolean;
	describedBy?: string;
};

/**
 * A reporting period: a relative preset ("Last 2 weeks"), a custom date
 * range, or free text the template accepts ("Sprint 42"). Every choice is
 * stored as the text the report's AI reads.
 */
export function PeriodParameterInput({
	id,
	value,
	onChange,
	schema,
	placeholder,
	required,
	invalid,
	describedBy,
}: Props) {
	const presets = useMemo(() => getPeriodPresets(schema), [schema]);
	const activePreset = findPeriodPreset(presets, value);
	// The first click of a range picks its start; only a full range is stored.
	const [pendingStart, setPendingStart] = useState<Date | undefined>();
	const storedRange = parsePeriodRange(value);

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					id={id}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					aria-required={required || undefined}
					aria-invalid={invalid || undefined}
					aria-describedby={describedBy}
					className="min-w-0 flex-1 basis-48"
				/>
				<DateRangePicker
					label="Dates"
					labels={RANGE_LABELS}
					presets={[]}
					value={
						pendingStart
							? { from: pendingStart }
							: (storedRange ?? {})
					}
					onChange={({ from, to }) => {
						if (from && to) {
							setPendingStart(undefined);
							onChange(formatPeriodRange(from, to));
							return;
						}
						setPendingStart(from);
						if (!from) {
							onChange("");
						}
					}}
					className="w-44"
				/>
			</div>
			<fieldset className="m-0 min-w-0 border-0 p-0">
				<legend className="sr-only">Relative periods</legend>
				<div className="flex flex-wrap gap-1.5">
					{presets.map((preset) => {
						const active = activePreset?.id === preset.id;
						return (
							<Button
								key={preset.id}
								type="button"
								size="sm"
								variant="outline"
								aria-pressed={active}
								onClick={() => onChange(preset.value)}
								className={cn(
									"h-7 rounded-full px-3 text-xs",
									active &&
										"border-primary/50 bg-primary/10 text-primary",
								)}
							>
								{preset.label}
							</Button>
						);
					})}
				</div>
			</fieldset>
		</div>
	);
}
