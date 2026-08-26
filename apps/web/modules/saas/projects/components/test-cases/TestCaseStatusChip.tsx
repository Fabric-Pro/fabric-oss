"use client";

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import { CHIP_CONFIG, type ChipStatus, TONE_CLASSES } from "./constants";

type Props = {
	status: ChipStatus;
	/** Optional translated label; falls back to the built-in English label. */
	label?: string;
	className?: string;
};

/**
 * A small status pill: a coloured dot + a text label. Modeled on the decisions
 * module's `DecisionStatusBadge`, but the accent comes from design-system
 * tokens (via `TONE_CLASSES`) rather than raw palette colours. The dot is
 * `aria-hidden` — the meaning is carried by the visible label text, so the chip
 * never communicates state through colour alone (WCAG 1.4.1).
 */
export function TestCaseStatusChip({ status, label, className }: Props) {
	const cfg = CHIP_CONFIG[status];
	const tone = TONE_CLASSES[cfg.tone];
	return (
		<Badge
			variant="outline"
			className={cn(
				"gap-1.5 font-medium text-foreground",
				tone.pill,
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 shrink-0 rounded-full", tone.dot)}
			/>
			{label ?? cfg.label}
		</Badge>
	);
}
