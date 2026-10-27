"use client";

/**
 * About preserves the title, description and quick-focus copy from the old hero
 * in a popover beside the page title. Keeping that explanation out of another
 * bordered band leaves room for the work-item list.
 *
 * Counts now share the results summary above the list. Conflict/failure triage
 * belongs to ReviewCenterInbox in the review controls, so it is not duplicated
 * here. Shared foreground, muted and surface tokens follow light and dark themes.
 */
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
export type RoadmapStats = {
	/** Visible work items (matches the old hero badge — excludes hidden/closed). */
	workItems: number;
	/** Priority lanes that currently hold at least one item. */
	lanes: number;
	/** Items linked to the PM tool. */
	synced: number;
	/** Items not yet linked to the PM tool. */
	unsynced: number;
};

export function RoadmapContextStrip() {
	const t = useTranslations("projects.stories.roadmapUi");
	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("aboutLabel")}
							className="text-muted-foreground hover:text-foreground"
						>
							<InfoIcon aria-hidden className="size-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("aboutLabel")}</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-80 space-y-3">
				<p className="app-editorial-label">{t("title")}</p>
				<h3 className="font-medium text-base">{t("aboutTitle")}</h3>
				<p className="text-sm text-muted-foreground">
					{t("aboutBody")}
				</p>
				<div className="rounded-lg border bg-muted p-3">
					<p className="font-medium text-sm">{t("quickFocus")}</p>
					<p className="mt-2 text-sm">{t("quickFocusBody")}</p>
				</div>
			</PopoverContent>
		</Popover>
	);
}
