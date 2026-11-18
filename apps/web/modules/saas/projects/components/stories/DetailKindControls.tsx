"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useRef } from "react";
import type { ChangeItemKind } from "./BacklogChangeProposal";

/**
 * Inline Feature/Bug toggle for the detail dialog header. Same visual contract
 * AND keyboard contract as the inline list's `KindSelector` so the PM sees
 * the same affordance in both contexts (roving tabindex, arrow keys move
 * selection, Home/End jump to ends).
 */
export function DetailKindSelector({
	selected,
	overridden,
	onChange,
	itemTitle,
}: {
	selected: ChangeItemKind;
	overridden: boolean;
	onChange: (next: ChangeItemKind) => void;
	itemTitle: string;
}) {
	const t = useTranslations("tooltips.stories");
	const options: Array<{ value: ChangeItemKind; label: string }> = [
		{ value: "FEATURE", label: "Feature" },
		{ value: "BUG", label: "Bug" },
	];
	const groupRef = useRef<HTMLDivElement>(null);
	const focusOption = (value: ChangeItemKind) => {
		const el = groupRef.current?.querySelector<HTMLButtonElement>(
			`button[data-kind-value="${value}"]`,
		);
		el?.focus();
	};
	const moveSelection = (delta: number) => {
		const i = options.findIndex((o) => o.value === selected);
		const next = options[(i + delta + options.length) % options.length]!;
		onChange(next.value);
		focusOption(next.value);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		switch (e.key) {
			case "ArrowLeft":
			case "ArrowUp":
				e.preventDefault();
				moveSelection(-1);
				break;
			case "ArrowRight":
			case "ArrowDown":
				e.preventDefault();
				moveSelection(1);
				break;
			case "Home":
				e.preventDefault();
				if (selected !== options[0]?.value) {
					onChange(options[0]?.value);
				}
				focusOption(options[0]?.value);
				break;
			case "End":
				e.preventDefault();
				if (selected !== options[options.length - 1]?.value) {
					onChange(options[options.length - 1]?.value);
				}
				focusOption(options[options.length - 1]?.value);
				break;
		}
	};
	return (
		<>
			<div
				ref={groupRef}
				role="radiogroup"
				aria-label={`Work item type for "${itemTitle}"`}
				onKeyDown={onKeyDown}
				className="inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5"
			>
				{options.map((opt) => {
					const isActive = opt.value === selected;
					return (
						// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup-on-buttons pattern (mirrors the inline list's KindSelector and Radix's ToggleGroup).
						<button
							key={opt.value}
							type="button"
							role="radio"
							aria-checked={isActive}
							data-kind-value={opt.value}
							tabIndex={isActive ? 0 : -1}
							onClick={() => {
								if (!isActive) {
									onChange(opt.value);
								}
							}}
							className={cn(
								"px-2 py-0.5 text-xs rounded font-medium leading-tight transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
								isActive
									? opt.value === "BUG"
										? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
										: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{opt.label}
						</button>
					);
				})}
				{/* The dot is decorative, so it stays `aria-hidden` and the tooltip
					is a pointer affordance. The `sr-only` note below sits outside
					the radiogroup — it gives the marker a real accessible identity,
					which the native `title` on an `aria-hidden` element never did,
					without putting stray content between the radios. */}
				{overridden && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								aria-hidden
								className="ml-1 mr-0.5 size-1.5 rounded-full bg-primary"
							/>
						</TooltipTrigger>
						<TooltipContent>{t("typeOverridden")}</TooltipContent>
					</Tooltip>
				)}
			</div>
			{overridden && (
				<span className="sr-only">{t("typeOverridden")}</span>
			)}
		</>
	);
}

/**
 * Read-only kind pill for UPDATE rows in the detail dialog. Mirrors the
 * inline list's `ReadOnlyKindBadge` so the PM sees the same affordance
 * whether reviewing inline or in the dialog. AI Update never changes the
 * kind of an existing item — kind conversion lives on the story detail
 * page (see ConvertKindConfirmDialog).
 */
export function DetailReadOnlyKindBadge({
	kind,
	itemTitle,
}: {
	kind: ChangeItemKind;
	itemTitle: string;
}) {
	const t = useTranslations("tooltips.stories");
	const label = kind === "BUG" ? "Bug" : "Feature";
	// `role="img"` + `aria-label` already carry the accessible identity, so only
	// the hover affordance moves to a tooltip — no `sr-only` duplicate needed.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={`Work item type for "${itemTitle}": ${label} (locked — update rows preserve the existing kind)`}
					className={cn(
						"inline-flex items-center px-2 py-0.5 text-xs rounded-md border bg-card font-medium leading-tight",
						// Same border-opacity contract as the inline list pill.
						kind === "BUG"
							? "border-red-300/80 text-red-800 dark:border-red-700/70 dark:text-red-300"
							: "border-blue-300/80 text-blue-800 dark:border-blue-700/70 dark:text-blue-300",
					)}
				>
					{label}
				</span>
			</TooltipTrigger>
			<TooltipContent>{t("kindLockedOnUpdate")}</TooltipContent>
		</Tooltip>
	);
}
