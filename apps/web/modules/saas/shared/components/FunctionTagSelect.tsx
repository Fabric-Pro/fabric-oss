"use client";

import {
	FUNCTION_TAG_LABELS,
	FUNCTION_TAG_ORDER,
	type FUNCTION_TAG_VALUES,
} from "@repo/database/src/function-tags";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

export type FunctionTagValue = (typeof FUNCTION_TAG_VALUES)[number];

type Props = {
	value: FunctionTagValue[];
	onChange: (next: FunctionTagValue[]) => void;
	disabled?: boolean;
	id?: string;
	"aria-label"?: string;
};

export function FunctionTagSelect({
	value,
	onChange,
	disabled,
	id,
	"aria-label": ariaLabel,
}: Props) {
	const [open, setOpen] = useState(false);
	const selected = new Set(value);

	// If `disabled` flips true while the popover is open, force it closed —
	// the `onOpenChange` guard below only blocks user-initiated toggles, so a
	// mid-open disable would otherwise strand the popover open.
	useEffect(() => {
		if (disabled) {
			setOpen(false);
		}
	}, [disabled]);

	const toggle = (tag: FunctionTagValue) => {
		// Preserve canonical display order and dedup.
		const next = FUNCTION_TAG_ORDER.filter((t) =>
			t === tag ? !selected.has(t) : selected.has(t),
		);
		onChange(next);
	};

	const remove = (tag: FunctionTagValue) => {
		if (disabled) {
			return;
		}
		onChange(value.filter((t) => t !== tag));
	};

	const selectedTags = FUNCTION_TAG_ORDER.filter((t) => selected.has(t));

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (!disabled) {
					setOpen(next);
				}
			}}
		>
			<PopoverTrigger asChild>
				<Button
					id={id}
					type="button"
					variant="outline"
					aria-label={ariaLabel}
					aria-expanded={open}
					disabled={disabled}
					className="h-auto min-h-9 w-full justify-between gap-2 font-normal"
				>
					<span className="flex flex-1 flex-wrap items-center gap-1.5 overflow-hidden text-left">
						{selectedTags.length === 0 ? (
							<span className="text-muted-foreground">
								Select function tags
							</span>
						) : (
							selectedTags.map((tag) => (
								<Badge
									key={tag}
									variant="secondary"
									className="gap-1 pr-1"
								>
									{FUNCTION_TAG_LABELS[tag]}
									{/* biome-ignore lint/a11y/useSemanticElements: this remove control lives inside the trigger <button>, so a nested native <button> would be invalid HTML. A role="button" span with click + keydown handlers preserves keyboard/AT semantics while stopping propagation so the popover doesn't toggle. */}
									<span
										role="button"
										tabIndex={disabled ? -1 : 0}
										aria-label={`Remove ${FUNCTION_TAG_LABELS[tag]}`}
										aria-disabled={disabled}
										onPointerDown={(e) =>
											e.stopPropagation()
										}
										onClick={(e) => {
											e.stopPropagation();
											e.preventDefault();
											remove(tag);
										}}
										onKeyDown={(e) => {
											if (
												e.key === "Enter" ||
												e.key === " "
											) {
												e.stopPropagation();
												e.preventDefault();
												remove(tag);
											}
										}}
										className="rounded-sm opacity-60 hover:opacity-100"
									>
										<XIcon className="size-3" />
									</span>
								</Badge>
							))
						)}
					</span>
					<ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-[--radix-popover-trigger-width] p-0"
				align="start"
			>
				<Command>
					<CommandList>
						<CommandEmpty>No tags.</CommandEmpty>
						<CommandGroup>
							{FUNCTION_TAG_ORDER.map((tag) => {
								const isSelected = selected.has(tag);
								return (
									<CommandItem
										key={tag}
										value={FUNCTION_TAG_LABELS[tag]}
										onSelect={() => toggle(tag)}
									>
										<CheckIcon
											className={`mr-2 size-4 ${isSelected ? "opacity-100" : "opacity-0"}`}
										/>
										{FUNCTION_TAG_LABELS[tag]}
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
