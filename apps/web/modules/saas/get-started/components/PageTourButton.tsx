"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { CompassIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { pageForTab } from "../lib/get-started-registry";
import { GET_STARTED_TOUR_PAGE_EVENT } from "../lib/tour-steps";

const GET_STARTED_ENABLED = isMonitoringFeatureEnabled("feature-get-started");

/**
 * A quiet "Get started" launcher that sits in a page header. Opens that page's
 * detailed tour. Deliberately understated (muted, no accent fill) so it never
 * competes with the page's own controls — it only brightens on hover/focus.
 * Renders nothing unless the page actually has a tour, so it can be dropped
 * into any header safely.
 */
export function PageTourButton({
	pageId,
	className,
}: {
	pageId: string;
	className?: string;
}) {
	// Declared before the flag/coverage early return so the hook order is stable.
	const t = useTranslations("tooltips.common");
	// Same rule: this hook runs unconditionally, above the early return. A
	// covered page can be gated per organization, so the coverage check below
	// needs a runtime answer the registry cannot supply for itself.
	const publishingSuiteEnabled = useFeatureFlag("PUBLISHING_SUITE");
	if (
		!GET_STARTED_ENABLED ||
		!pageForTab(pageId, { publishingSuite: publishingSuiteEnabled })
	) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label="Get started with this page"
					onClick={() =>
						window.dispatchEvent(
							new CustomEvent(GET_STARTED_TOUR_PAGE_EVENT, {
								detail: { pageId },
							}),
						)
					}
					className={cn(
						"inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
						"text-muted-foreground/55 transition-colors",
						"hover:bg-muted/60 hover:text-foreground",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
						className,
					)}
				>
					<CompassIcon className="size-[17px]" />
				</button>
			</TooltipTrigger>
			<TooltipContent>{t("startPageTour")}</TooltipContent>
		</Tooltip>
	);
}
