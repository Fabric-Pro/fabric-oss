"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { TEST_CASE_PRIORITIES, type TestCasePriority } from "./constants";
import { TestCasePriorityBars } from "./TestCasePriorityBars";

type Props = {
	value: TestCasePriority;
	onChange: (next: TestCasePriority) => void;
	/** Translate a priority enum to its display label. */
	labelFor: (priority: TestCasePriority) => string;
	/** Accessible label for the trigger (name the item + current value). */
	ariaLabel: string;
	disabled?: boolean;
	/** In-flight write — shows a spinner and blocks re-selection. */
	pending?: boolean;
	/**
	 * Drop the text label, keeping the bars and the chevron.
	 *
	 * For the cases table, where the priority column is 44px and the full chip
	 * ("▮▮▮ Critical ⌄") needs well over twice that. It did not clip — it
	 * overflowed, drawing "Critical ⌄" straight over the owner and last-run
	 * cells beside it. The bars already carry the value as a non-colour signal,
	 * and the label stays in the trigger's accessible name and its `title`, so
	 * nothing is lost to a screen reader or to a hover.
	 */
	compact?: boolean;
	className?: string;
};

/**
 * An inline, editable priority chip: filled signal bars + label trigger opening
 * a Radix DropdownMenu of the priorities (worst-to-best order preserved). Radix
 * provides full keyboard operability + focus management; the trigger carries an
 * `aria-label` naming the current value. When `disabled`, it degrades to the
 * static `TestCasePriorityBars`. The fill count + label are the non-colour
 * signal. Shared primitive reused by the list, the editor drawer and plans.
 */
export function EditablePriorityChip({
	value,
	onChange,
	labelFor,
	ariaLabel,
	disabled = false,
	pending = false,
	compact = false,
	className,
}: Props) {
	if (disabled) {
		return (
			<TestCasePriorityBars
				priority={value}
				label={labelFor(value)}
				showLabel={!compact}
				className={className}
			/>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={pending}>
				<button
					type="button"
					aria-label={ariaLabel}
					// The value in words, for a sighted reader who only sees bars.
					title={compact ? labelFor(value) : undefined}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full border border-border/70 py-0.5 font-medium text-foreground text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
						compact ? "gap-1 px-1.5" : "px-2",
						className,
					)}
				>
					<TestCasePriorityBars
						priority={value}
						label={labelFor(value)}
					/>
					{!compact && labelFor(value)}
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
				{TEST_CASE_PRIORITIES.map((priority) => {
					const active = priority === value;
					return (
						<DropdownMenuItem
							key={priority}
							onSelect={() => {
								if (!active) {
									onChange(priority);
								}
							}}
							className="gap-2"
						>
							<TestCasePriorityBars
								priority={priority}
								label={labelFor(priority)}
							/>
							<span className="flex-1">{labelFor(priority)}</span>
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
