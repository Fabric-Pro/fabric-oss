"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { GitMergeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

type DeclinedDuplicateBadgeProps = {
	size?: "card" | "detail";
	/** Identifier of the survivor this item was merged into (e.g. "F-098"), for
	 * the tooltip. Omitted/null → a generic tooltip. */
	mergedIntoIdentifier?: string | null;
};

/**
 * Static roadmap chip marking a story that was discarded by a duplicate-merge
 * (moved to the CLOSED stage). Mirrors the placement/shape of the
 * "Possible duplicate" / "Needs more info" chips but uses neutral muted tokens
 * (not the amber `--highlight` attention palette) because this is a resolved,
 * informational state — not an action item. Non-interactive (the pair is
 * already resolved), with a tooltip explaining what happened.
 */
export function DeclinedDuplicateBadge({
	size = "card",
	mergedIntoIdentifier,
}: DeclinedDuplicateBadgeProps) {
	const t = useTranslations("projects.stories.duplicates");
	const sizing =
		size === "detail"
			? "px-2 py-0.5 text-[11px]"
			: "px-1.5 py-0.5 text-[10px]";
	const tooltip = mergedIntoIdentifier
		? t("declinedTooltipKnown", { identifier: mergedIntoIdentifier })
		: t("declinedTooltipGeneric");

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					{/* Visible text is the accessible name; the tooltip is wired
					    as the description via Radix `aria-describedby`. */}
					<span
						className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted font-medium text-muted-foreground ${sizing}`}
					>
						<GitMergeIcon className="size-3" aria-hidden="true" />
						{t("declinedChip")}
					</span>
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
