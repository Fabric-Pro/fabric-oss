"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

interface DuplicateBadgeProps {
	/** "card" matches the compact sizing on roadmap/kanban cards; "detail" is
	 * the larger sizing for a detail surface. */
	size?: "card" | "detail";
	/** "duplicate" — at least one partner is a genuine duplicate; "overlap" —
	 * every partner is overlapping scope only (same feature area, different
	 * framing), so the softer label is shown. */
	variant?: "duplicate" | "overlap";
	/** Number of potential-duplicate partners this story has. */
	count: number;
	tooltip: ReactNode;
	onClick: () => void;
}

/**
 * Compact "possible duplicate" / "overlapping scope" chip shown on a roadmap
 * feature card when the semantic scan has flagged it as part of a
 * potential-duplicate pair. Clicking opens the resolve dialog. Uses the amber
 * `--highlight` attention tokens (no hardcoded colors) and is fully
 * keyboard-reachable.
 */
export function DuplicateBadge({
	size = "card",
	variant = "duplicate",
	count,
	tooltip,
	onClick,
}: DuplicateBadgeProps) {
	const t = useTranslations("projects.stories.duplicates");
	const sizing =
		size === "detail"
			? "px-2 py-0.5 text-[11px]"
			: "px-1.5 py-0.5 text-[10px]";
	const label =
		variant === "overlap"
			? count > 1
				? t("chipOverlapMulti", { count })
				: t("chipOverlapSingle")
			: count > 1
				? t("chipMulti", { count })
				: t("chipSingle");

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 font-medium text-highlight-foreground dark:text-muted-foreground transition-colors hover:bg-highlight/20 ${sizing}`}
						aria-label={t("chipAria", { label })}
					>
						<CopyIcon className="size-3" aria-hidden="true" />
						{label}
					</button>
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
