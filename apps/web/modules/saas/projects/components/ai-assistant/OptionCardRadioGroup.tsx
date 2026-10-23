"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Badge } from "@ui/components/badge";

export type OptionCard<T extends string> = {
	value: T;
	label: string;
	hint: string;
	isDefault?: boolean;
};

/**
 * A radio group whose options are cards — label, a Default badge, and the
 * hint visible for every option rather than only the selected one, so the
 * choice can be made without opening anything. Radix supplies the roles, the
 * roving focus and the arrow keys.
 */
export function OptionCardRadioGroup<T extends string>({
	labelledBy,
	options,
	value,
	onValueChange,
	disabled,
}: {
	labelledBy: string;
	options: readonly OptionCard<T>[];
	value: T;
	onValueChange: (next: T) => void;
	disabled: boolean;
}) {
	return (
		<RadioGroupPrimitive.Root
			aria-labelledby={labelledBy}
			value={value}
			disabled={disabled}
			loop
			onValueChange={(next) => {
				const option = options.find((o) => o.value === next);
				if (option) {
					onValueChange(option.value);
				}
			}}
			className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2"
		>
			{options.map((option) => (
				<RadioGroupPrimitive.Item
					key={option.value}
					value={option.value}
					className="group flex flex-col gap-1.5 rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border data-[state=checked]:border-foreground/40 data-[state=checked]:bg-muted"
				>
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
						<span
							aria-hidden="true"
							className="flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 group-data-[state=checked]:border-foreground"
						>
							<span className="size-2 rounded-full group-data-[state=checked]:bg-foreground" />
						</span>
						<span className="font-medium text-sm">
							{option.label}
						</span>
						{option.isDefault && (
							<Badge variant="info">Default</Badge>
						)}
					</span>
					<span className="text-pretty pl-6 text-muted-foreground text-xs leading-snug">
						{option.hint}
					</span>
				</RadioGroupPrimitive.Item>
			))}
		</RadioGroupPrimitive.Root>
	);
}
