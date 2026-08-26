"use client";

import type { GraphMode } from "@repo/atlas/types";
/**
 * Business ⇄ Technical segmented control for the Atlas graph.
 *
 * Business is listed first (left) and is the default mode. There is no Radix
 * ToggleGroup in the UI kit, so this is a hand-rolled, fully-accessible
 * `radiogroup`: arrow keys move between options, Space/Enter select, and the
 * active option carries `aria-checked`. Token-only styling. Each option has an
 * info tooltip explaining what the mode shows.
 */
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { InfoIcon, LayersIcon, NetworkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef } from "react";

interface AtlasModeToggleProps {
	mode: GraphMode;
	onChange: (mode: GraphMode) => void;
	disabled?: boolean;
}

// Business is listed first per AC#2.
const ORDER: GraphMode[] = ["BUSINESS", "TECHNICAL"];

export function AtlasModeToggle({
	mode,
	onChange,
	disabled = false,
}: AtlasModeToggleProps) {
	const t = useTranslations("projects.atlas.mode");
	const refs = useRef<Map<GraphMode, HTMLButtonElement>>(new Map());

	const focusAndSelect = useCallback(
		(next: GraphMode) => {
			onChange(next);
			refs.current.get(next)?.focus();
		},
		[onChange],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (
				event.key !== "ArrowRight" &&
				event.key !== "ArrowLeft" &&
				event.key !== "ArrowUp" &&
				event.key !== "ArrowDown"
			) {
				return;
			}
			event.preventDefault();
			const currentIndex = ORDER.indexOf(mode);
			const delta =
				event.key === "ArrowRight" || event.key === "ArrowDown"
					? 1
					: -1;
			const nextIndex =
				(currentIndex + delta + ORDER.length) % ORDER.length;
			focusAndSelect(ORDER[nextIndex]);
		},
		[mode, focusAndSelect],
	);

	const options: {
		value: GraphMode;
		label: string;
		icon: typeof LayersIcon;
		tooltip: string;
	}[] = [
		{
			value: "BUSINESS",
			label: t("business"),
			icon: LayersIcon,
			tooltip: t("businessTooltip"),
		},
		{
			value: "TECHNICAL",
			label: t("technical"),
			icon: NetworkIcon,
			tooltip: t("technicalTooltip"),
		},
	];

	return (
		<div className="inline-flex items-center gap-2">
			<div
				role="radiogroup"
				aria-label={t("label")}
				onKeyDown={handleKeyDown}
				className={cn(
					"inline-flex items-center gap-1 rounded-xl border border-border/60 bg-muted/60 p-1",
					disabled && "opacity-60",
				)}
			>
				{options.map((option) => {
					const Icon = option.icon;
					const isActive = mode === option.value;
					return (
						// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup pattern — a styled <button> with role="radio" carries the icon+label and roving tabindex/arrow-key behaviour that a native <input type="radio"> cannot.
						<button
							key={option.value}
							ref={(el) => {
								if (el) {
									refs.current.set(option.value, el);
								} else {
									refs.current.delete(option.value);
								}
							}}
							type="button"
							role="radio"
							aria-checked={isActive}
							tabIndex={isActive ? 0 : -1}
							disabled={disabled}
							onClick={() => onChange(option.value)}
							className={cn(
								"flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								isActive
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
								disabled && "cursor-not-allowed",
							)}
						>
							<Icon
								aria-hidden="true"
								className={cn(
									"size-4",
									isActive && "text-primary",
								)}
							/>
							{option.label}
						</button>
					);
				})}
			</div>
			{/* A single info affordance to the right of the toggle, explaining
			    BOTH views (replaces the two per-option icons). */}
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={t("infoLabel")}
						className="cursor-help rounded-full p-1 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<InfoIcon aria-hidden="true" className="size-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs space-y-1.5">
					{options.map((option) => (
						<p key={option.value}>
							{/* Inherit the tooltip's foreground (light on the dark
							    tooltip) — only the weight distinguishes the label. */}
							<span className="font-semibold">
								{option.label}
							</span>{" "}
							— {option.tooltip}
						</p>
					))}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
