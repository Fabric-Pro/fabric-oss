"use client";

import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ListChecksIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useActiveJobCount } from "../hooks/use-active-job-count";
import { JobHubPanel } from "./JobHubPanel";

/**
 * Persistent Job Hub entry point in the app navigation.
 *
 * Always rendered (not hidden when idle) so the panel is where users learn it
 * is — the history of recent jobs is useful even with nothing running.
 */
export function JobHubButton({
	variant = "desktop",
}: {
	variant?: "desktop" | "mobile";
}) {
	const t = useTranslations("app.jobs");
	const [open, setOpen] = useState(false);
	// Read the flag before the hook, and pass it in: hooks cannot be called
	// conditionally, so an early return alone would hide the icon while every
	// client kept polling the count.
	const enabled = isMonitoringFeatureEnabled("feature-job-hub");
	const { data } = useActiveJobCount(enabled);

	if (!enabled) {
		return null;
	}

	const count = data?.count ?? 0;
	const label = count > 0 ? t("activeLabel", { count }) : t("openLabel");

	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				aria-label={label}
				className="relative"
				onClick={() => setOpen(true)}
				data-variant={variant}
			>
				<ListChecksIcon className="size-5" />
				{count > 0 ? (
					<Badge
						variant="default"
						className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none tabular-nums"
					>
						{count > 99 ? "99+" : count}
					</Badge>
				) : null}
			</Button>

			<JobHubPanel open={open} onOpenChange={setOpen} />
		</>
	);
}
