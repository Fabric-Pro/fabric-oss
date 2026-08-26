"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import {
	STATE_TONE,
	TEST_CASE_STATES,
	type TestCaseState,
	TONE_CLASSES,
} from "./constants";
import { TestCaseStatusChip } from "./TestCaseStatusChip";

type Props = {
	value: TestCaseState;
	onChange: (next: TestCaseState) => void;
	/** Translate a state enum to its display label. */
	labelFor: (state: TestCaseState) => string;
	/** Accessible label for the trigger (name the item + current value). */
	ariaLabel: string;
	disabled?: boolean;
	/** In-flight write — shows a spinner and blocks re-selection. */
	pending?: boolean;
	className?: string;
};

/**
 * An inline, editable state chip: a dot + label trigger opening a Radix
 * DropdownMenu of the states. Radix gives full keyboard operability (arrow keys,
 * Enter, Esc, type-ahead) and focus management for free; the trigger carries an
 * `aria-label` naming the current value. When `disabled`, it degrades to the
 * static `TestCaseStatusChip` (no colour-only meaning — dot + text throughout).
 * Shared primitive reused by the list, the editor drawer and plans.
 */
export function EditableStateChip({
	value,
	onChange,
	labelFor,
	ariaLabel,
	disabled = false,
	pending = false,
	className,
}: Props) {
	if (disabled) {
		return (
			<TestCaseStatusChip
				status={value}
				label={labelFor(value)}
				className={className}
			/>
		);
	}

	const tone = TONE_CLASSES[STATE_TONE[value]];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={pending}>
				<button
					type="button"
					aria-label={ariaLabel}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-foreground text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
						tone.pill,
						className,
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							tone.dot,
						)}
					/>
					{labelFor(value)}
					{pending ? (
						<Loader2Icon
							aria-hidden="true"
							className="size-3 text-muted-foreground motion-safe:animate-spin"
						/>
					) : (
						<ChevronDownIcon
							aria-hidden="true"
							className="size-3 text-muted-foreground"
						/>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-[9rem]">
				{TEST_CASE_STATES.map((state) => {
					const itemTone = TONE_CLASSES[STATE_TONE[state]];
					const active = state === value;
					return (
						<DropdownMenuItem
							key={state}
							onSelect={() => {
								if (!active) {
									onChange(state);
								}
							}}
							className="gap-2"
						>
							<span
								aria-hidden="true"
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									itemTone.dot,
								)}
							/>
							<span className="flex-1">{labelFor(state)}</span>
							{active && (
								<CheckIcon
									aria-hidden="true"
									className="size-3.5 text-muted-foreground"
								/>
							)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
