"use client";

import { Button } from "@ui/components/button";
import { Calendar } from "@ui/components/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";

import { cn } from "@ui/lib";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import * as React from "react";

interface DatePickerProps {
	value?: Date | string;
	onChange?: (date: Date | undefined) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	id?: string;
	"aria-label"?: string;
	"aria-required"?: boolean;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}

export function DatePicker({
	value,
	onChange,
	placeholder = "Pick a date",
	className,
	disabled,
	id,
	"aria-label": ariaLabel,
	"aria-required": ariaRequired,
	"aria-invalid": ariaInvalid,
	"aria-describedby": ariaDescribedBy,
}: DatePickerProps) {
	// Convert string value to Date if needed
	const dateValue = React.useMemo(() => {
		if (!value) {
			return undefined;
		}
		if (value instanceof Date) {
			return value;
		}
		// Handle YYYY-MM-DD format
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}, [value]);

	const visibleLabel = dateValue ? format(dateValue, "PPP") : placeholder;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					id={id}
					variant="outline"
					disabled={disabled}
					aria-required={ariaRequired}
					aria-invalid={ariaInvalid}
					aria-describedby={ariaDescribedBy}
					aria-label={
						ariaLabel ? `${ariaLabel}: ${visibleLabel}` : undefined
					}
					className={cn(
						"w-[240px] justify-start text-left font-normal",
						!dateValue && "text-muted-foreground",
						className,
					)}
				>
					<CalendarIcon className="mr-2 h-4 w-4" />
					{visibleLabel}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				collisionPadding={16}
				className="w-auto p-0"
				align="start"
			>
				<Calendar
					mode="single"
					defaultMonth={dateValue}
					selected={dateValue}
					onSelect={onChange}
					initialFocus
				/>
			</PopoverContent>
		</Popover>
	);
}
