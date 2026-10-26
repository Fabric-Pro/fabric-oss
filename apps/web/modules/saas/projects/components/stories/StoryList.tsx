"use client";

import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RoadmapColumns } from "../../hooks/useRoadmapView";

// One geometry for the header, rows and drag targets. Horizontal scrolling on
// narrow screens preserves the title column instead of wrapping leading cells.
export const STORY_LIST_GRID =
	"grid grid-cols-[3rem_5.625rem_minmax(0,1fr)_6rem_9.125rem_5.375rem_2rem] items-center gap-x-2 px-2.5";

export function StoryList({
	columns,
	children,
}: {
	columns?: Partial<RoadmapColumns>;
	children: ReactNode;
}) {
	const t = useTranslations("projects.stories.listRow");
	return (
		<section
			className="overflow-x-auto rounded-lg border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={t("items")}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: A labelled scroll region needs keyboard access to overflow columns.
			tabIndex={0}
		>
			<div className="min-w-[52rem]">
				<div
					className={cn(
						STORY_LIST_GRID,
						"border-b border-border/50 bg-muted/40 py-2 text-xs text-muted-foreground",
					)}
				>
					<span className="sr-only">{t("selection")}</span>
					<span className="col-start-2">{t("item")}</span>
					<span>{t("title")}</span>
					<span>{t("priority")}</span>
					<span>{columns?.stage !== false && t("stage")}</span>
					<span>{t("pm")}</span>
					<span className="sr-only">{t("actions")}</span>
				</div>
				{children}
			</div>
		</section>
	);
}
