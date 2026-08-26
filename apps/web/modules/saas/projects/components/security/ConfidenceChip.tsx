"use client";

/**
 * Confidence chip (G1) — shows how confident the scanner was that a finding is
 * real, as a categorical High / Medium / Low badge.
 *
 * Accessibility: the chip carries BOTH an icon and the level text, so meaning
 * never rests on color alone (WCAG 1.4.1). The icon is decorative
 * (`aria-hidden`); the visible "High" / "Medium" / "Low" text plus the
 * `title`/`aria-label` ("High confidence") convey the level to every user.
 */

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import {
	type LucideIcon,
	SignalHighIcon,
	SignalLowIcon,
	SignalMediumIcon,
} from "lucide-react";
import {
	CONFIDENCE_BADGE_VARIANT,
	CONFIDENCE_LABEL,
	confidenceLevel,
} from "./lib";

const CONFIDENCE_ICON = {
	HIGH: SignalHighIcon,
	MEDIUM: SignalMediumIcon,
	LOW: SignalLowIcon,
} satisfies Record<"HIGH" | "MEDIUM" | "LOW", LucideIcon>;

export function ConfidenceChip({
	confidence,
	className,
}: {
	/** Stored confidence float (0..1) or null on legacy / not-yet-rescanned rows. */
	confidence: number | null | undefined;
	className?: string;
}) {
	const level = confidenceLevel(confidence);
	if (!level) {
		return null;
	}
	const Icon = CONFIDENCE_ICON[level];
	return (
		<Badge
			variant={CONFIDENCE_BADGE_VARIANT[level]}
			className={cn("gap-1 font-normal", className)}
			title={`${CONFIDENCE_LABEL[level]} confidence`}
			aria-label={`${CONFIDENCE_LABEL[level]} confidence`}
		>
			<Icon aria-hidden="true" className="size-3" />
			{CONFIDENCE_LABEL[level]}
		</Badge>
	);
}
