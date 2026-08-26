"use client";

import { cn } from "@ui/lib";
import {
	PRIORITY_LEVEL,
	PRIORITY_TONE,
	type TestCasePriority,
	TONE_CLASSES,
} from "./constants";

/** Built-in English labels so the bars render without an i18n provider. */
const PRIORITY_LABEL: Record<TestCasePriority, string> = {
	LOW: "Low",
	MEDIUM: "Medium",
	HIGH: "High",
	CRITICAL: "Critical",
};

/** Signal-bar heights (shortest → tallest) so the fill count reads at a glance. */
const BAR_HEIGHTS = ["h-1.5", "h-2", "h-2.5", "h-3"] as const;

type Props = {
	priority: TestCasePriority;
	/** Optional translated label; falls back to the built-in English label. */
	label?: string;
	/** Render the text label after the bars (defaults to bars-only). */
	showLabel?: boolean;
	className?: string;
};

/**
 * Priority as a filled signal-bar count (1–4) — the fill count and the label are
 * the non-colour signal; the tone colour is secondary. Shared primitive reused
 * by the cases list, the editor drawer and the plan detail.
 */
export function TestCasePriorityBars({
	priority,
	label,
	showLabel = false,
	className,
}: Props) {
	const level = PRIORITY_LEVEL[priority];
	const tone = TONE_CLASSES[PRIORITY_TONE[priority]];
	const text = label ?? PRIORITY_LABEL[priority];
	return (
		<span
			className={cn("inline-flex items-center gap-1.5", className)}
			// The bars are decorative for assistive tech; the priority is named
			// here (and/or by the visible label) so meaning never rides on colour.
			role="img"
			aria-label={text}
		>
			<span aria-hidden="true" className="flex items-end gap-0.5">
				{BAR_HEIGHTS.map((h, i) => (
					<span
						key={h}
						className={cn(
							"w-1 rounded-[1px]",
							h,
							i < level ? tone.solid : "bg-muted",
						)}
					/>
				))}
			</span>
			{showLabel && (
				<span className="font-medium text-foreground text-xs">
					{text}
				</span>
			)}
		</span>
	);
}
