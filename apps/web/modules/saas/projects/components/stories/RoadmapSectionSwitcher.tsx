"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ListIcon, ListOrderedIcon } from "lucide-react";
import { useTranslations } from "next-intl";

const OPTIONS = [
	{
		value: "items" as const,
		labelKey: "itemsLabel" as const,
		Icon: ListIcon,
		tooltipKey: "itemsTooltip" as const,
	},
	{
		value: "priority" as const,
		labelKey: "priorityLabel" as const,
		Icon: ListOrderedIcon,
		tooltipKey: "priorityTooltip" as const,
	},
];

/**
 * The Roadmap's top-level "what am I looking at" switch: the full work-item
 * list, or the scored Priority worklist.
 *
 * This exists because Priority spent its first release as a fourth option in a
 * personal Settings → Layout toggle, next to Table / Board / Plain. That framed
 * a shared, scored management surface as a private rendering preference —
 * somewhere people change once and never find again. Table / Board / Plain are
 * three ways to draw the same list; Priority is a different list with different
 * verbs, so it belongs one level up, in the page.
 *
 * Deliberately compact: it shares a lane with the result count, so it carries no
 * card, no border of its own and no explanatory paragraph — the explanation
 * lives in the per-option tooltip and in "How priority works".
 */
export function RoadmapSectionSwitcher({
	value,
	onChange,
}: {
	value: "items" | "priority";
	onChange: (next: "items" | "priority") => void;
}) {
	const t = useTranslations("projects.stories.roadmapSections");
	return (
		<div
			role="group"
			aria-label={t("groupAriaLabel")}
			data-onboarding-target="roadmap-priority"
			className="flex shrink-0 rounded-md border border-border/60 bg-card p-0.5"
		>
			{OPTIONS.map(({ value: option, labelKey, Icon, tooltipKey }) => {
				const active = option === value;
				const label = t(labelKey);
				return (
					<Tooltip key={option}>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-pressed={active}
								// The visible label collapses below `sm`, so the
								// accessible name has to come from here or a
								// screen-reader user hears only "button".
								aria-label={label}
								onClick={() => onChange(option)}
								className={cn(
									"flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active
										? "bg-primary text-primary-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
							>
								<Icon aria-hidden className="size-3.5" />
								{/* The label collapses below `sm`; the icon plus
								    the tooltip still identify the option, and the
								    control stops competing with the count for
								    room on a phone. */}
								<span className="hidden sm:inline">
									{label}
								</span>
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							{t(tooltipKey)}
						</TooltipContent>
					</Tooltip>
				);
			})}
		</div>
	);
}
