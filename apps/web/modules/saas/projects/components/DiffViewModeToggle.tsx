"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { AlignLeft, Columns2, Eye, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DiffViewMode } from "../lib/diff-view-modes";

interface DiffViewModeToggleProps {
	value: DiffViewMode;
	onChange: (mode: DiffViewMode) => void;
	className?: string;
}

interface ModeOption {
	mode: DiffViewMode;
	icon: LucideIcon;
	/** i18n key (within `tooltips.documentEditor`) for the visible/aria label. */
	labelKey: string;
	/** i18n key for the informational tooltip describing what the mode shows. */
	tooltipKey: string;
}

// Order is load-bearing (Inline → Side by side → Full preview) and is asserted
// by the component test and the spec's mode table.
const MODE_OPTIONS: readonly ModeOption[] = [
	{
		mode: "inline",
		icon: AlignLeft,
		labelKey: "diffModeInline",
		tooltipKey: "diffModeInlineTooltip",
	},
	{
		mode: "sideBySide",
		icon: Columns2,
		labelKey: "diffModeSideBySide",
		tooltipKey: "diffModeSideBySideTooltip",
	},
	{
		mode: "fullPreview",
		icon: Eye,
		labelKey: "diffModeFullPreview",
		tooltipKey: "diffModeFullPreviewTooltip",
	},
] as const;

/**
 * Accessible three-option segmented control for choosing the document diff
 * review presentation: Inline (live red/green marks), Side by side, or Full
 * preview.
 *
 * Built on the Radix RadioGroup primitive so the whole control is a single tab
 * stop with roving tabindex, arrow-key selection, and `role="radiogroup"` /
 * `role="radio"` + `aria-checked` semantics for free. Each option renders as an
 * icon + short text label segment (not the default radio dot) with its own
 * `aria-label` and an informational `<Tooltip>`.
 *
 * Pure presentational: it owns no state — the selected mode and the change
 * handler are supplied by the caller (which persists the choice).
 */
export function DiffViewModeToggle({
	value,
	onChange,
	className,
}: DiffViewModeToggleProps) {
	const t = useTranslations("tooltips.documentEditor");

	return (
		<RadioGroupPrimitive.Root
			aria-label={t("diffViewModeLabel")}
			value={value}
			onValueChange={(next) => onChange(next as DiffViewMode)}
			// Leave `orientation` unset so both axes navigate: Left/Up move to the
			// previous segment and Right/Down to the next (a fixed orientation
			// would make the cross-axis arrows inert). `loop` wraps past the ends.
			loop
			className={cn(
				"inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/60 p-0.5",
				className,
			)}
		>
			{MODE_OPTIONS.map(({ mode, icon: Icon, labelKey, tooltipKey }) => {
				const label = t(labelKey);
				// Drive the selected styling from `value` directly. We can't key off
				// Radix's `data-[state=checked]` here: each Item is also a
				// `TooltipTrigger asChild`, and the Tooltip writes its OWN
				// `data-state` ("closed"/"open") onto the same element, clobbering
				// the RadioGroup's `data-state="checked"`. The component owns `value`,
				// so compare against it (and `aria-checked` stays correct for AT).
				const isActive = mode === value;
				return (
					<Tooltip key={mode}>
						<TooltipTrigger asChild>
							<RadioGroupPrimitive.Item
								value={mode}
								aria-label={label}
								className={cn(
									// `border-transparent` reserves the 1px edge so selecting
									// a segment never shifts the layout.
									"inline-flex items-center gap-1.5 rounded-[5px] border border-transparent px-2 py-1 text-xs font-medium",
									"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
									"motion-safe:transition-colors motion-safe:duration-150",
									isActive
										? // Selected: an elevated card "pill" with a defined edge
											// and brand-accent (deep rose) text + icon, so the active
											// mode is unmistakable in both light and dark themes. The
											// elevation/border carry the state independent of color
											// (color-blind safe); `aria-checked` carries it for AT.
											"border-border bg-card text-primary shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Icon
									className="size-3.5 shrink-0"
									aria-hidden="true"
								/>
								<span className="hidden sm:inline">
									{label}
								</span>
							</RadioGroupPrimitive.Item>
						</TooltipTrigger>
						<TooltipContent>{t(tooltipKey)}</TooltipContent>
					</Tooltip>
				);
			})}
		</RadioGroupPrimitive.Root>
	);
}
