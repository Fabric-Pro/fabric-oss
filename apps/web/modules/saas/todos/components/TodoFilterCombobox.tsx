"use client";

import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * One searchable filter over an UNBOUNDED set (Fizzy #2340).
 *
 * WHY THIS IS NOT A PILL ROW. The view scope beside it is three fixed values
 * and stays pills. Projects and assignees are not: a workspace with twenty
 * projects and a dozen contacts renders as a wall of pills that wraps to four
 * or five lines and pushes the list itself below the fold — on the product's
 * new primary surface, where the list IS the page. A combobox costs one click
 * and is constant height whatever the workspace holds; the selection then
 * reappears as a removable chip above the list, so an active filter is still
 * visible at a glance rather than hidden inside a closed popover.
 *
 * Filtering is done here rather than by cmdk (`shouldFilter={false}`) for the
 * same reason `AuditLogProjectFilter` does it: the caller owns the option set,
 * and a match rule written where the options are read is one that can be
 * tested without driving a popover.
 */
interface TodoFilterComboboxProps<TOption> {
	/** What this filter narrows, shown before the current value. */
	label: string;
	/** Trigger text while nothing is selected. */
	placeholder: string;
	searchPlaceholder: string;
	emptyMessage: string;
	ariaLabel: string;
	options: TOption[];
	/** Stable identity of an option — ids alone can collide across kinds. */
	optionKey: (option: TOption) => string;
	optionLabel: (option: TOption) => string;
	renderOption?: (option: TOption) => ReactNode;
	selectedKey: string | null;
	/** Selecting the current value clears it, so one control both sets and unsets. */
	onSelect: (option: TOption | null) => void;
	icon?: ReactNode;
	testId: string;
}

export function TodoFilterCombobox<TOption>({
	label,
	placeholder,
	searchPlaceholder,
	emptyMessage,
	ariaLabel,
	options,
	optionKey,
	optionLabel,
	renderOption,
	selectedKey,
	onSelect,
	icon,
	testId,
}: TodoFilterComboboxProps<TOption>) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	const selected =
		options.find((option) => optionKey(option) === selectedKey) ?? null;

	const needle = query.trim().toLowerCase();
	const visible = needle
		? options.filter((option) =>
				optionLabel(option).toLowerCase().includes(needle),
			)
		: options;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					role="combobox"
					aria-expanded={open}
					aria-label={ariaLabel}
					data-testid={`${testId}-trigger`}
					className="h-9 max-w-full gap-2 text-sm"
				>
					{icon}
					<span className="text-muted-foreground">{label}:</span>
					<span className="min-w-0 truncate text-foreground">
						{selected ? optionLabel(selected) : placeholder}
					</span>
					<ChevronDownIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-72 p-0"
				align="start"
				data-testid={`${testId}-popover`}
			>
				<Command shouldFilter={false}>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={searchPlaceholder}
						data-testid={`${testId}-search`}
					/>
					<CommandList>
						<CommandEmpty>{emptyMessage}</CommandEmpty>
						<CommandGroup>
							{visible.map((option) => {
								const key = optionKey(option);
								const isSelected = key === selectedKey;
								return (
									<CommandItem
										key={key}
										value={key}
										onSelect={() => {
											onSelect(
												isSelected ? null : option,
											);
											setOpen(false);
											setQuery("");
										}}
										className="flex items-center gap-2"
									>
										<span className="min-w-0 flex-1 truncate">
											{renderOption
												? renderOption(option)
												: optionLabel(option)}
										</span>
										<CheckIcon
											aria-hidden="true"
											className={cn(
												"size-3.5 shrink-0 text-primary",
												isSelected
													? "opacity-100"
													: "opacity-0",
											)}
										/>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
