"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@ui/lib";

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	disabled?: boolean;
}

/**
 * A compact choice between a few options, as one bordered strip. A radio
 * group underneath, so arrow keys move between options and screen readers
 * announce the choice.
 */
export function SegmentedControl<T extends string>({
	value,
	options,
	onValueChange,
	ariaLabel,
	disabled = false,
}: {
	value: T;
	options: SegmentedOption<T>[];
	onValueChange: (value: T) => void;
	ariaLabel: string;
	disabled?: boolean;
}) {
	return (
		<RadioGroupPrimitive.Root
			aria-label={ariaLabel}
			className="inline-flex w-fit overflow-hidden rounded-md border border-border bg-card"
			disabled={disabled}
			onValueChange={(next) => onValueChange(next as T)}
			value={value}
		>
			{options.map((option) => (
				<RadioGroupPrimitive.Item
					className={cn(
						"px-3 py-1.5 text-muted-foreground text-sm motion-safe:transition-colors",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
						"data-[state=checked]:bg-foreground data-[state=checked]:text-background",
						"disabled:cursor-not-allowed disabled:opacity-50",
					)}
					disabled={option.disabled}
					key={option.value}
					value={option.value}
				>
					{option.label}
				</RadioGroupPrimitive.Item>
			))}
		</RadioGroupPrimitive.Root>
	);
}
