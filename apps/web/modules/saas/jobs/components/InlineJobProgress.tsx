"use client";

import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { JobListItem } from "../hooks/use-jobs";
import { formatJobCounts } from "../lib/format-job";

/**
 * One-line "this connection is working right now" indicator for a repository
 * or channel row, so basic status is visible without opening the Job Hub.
 *
 * Renders nothing when no job is running — an idle row keeps the layout it has
 * always had.
 */
export function InlineJobProgress({ job }: { job?: JobListItem }) {
	const t = useTranslations("app.jobs");

	if (!job || job.status !== "RUNNING") {
		return null;
	}

	const counts = formatJobCounts(job.counts, (key, values) =>
		t(`counts.${key}`, values),
	);

	return (
		<span
			className="flex items-center gap-1.5 text-highlight"
			role="status"
			aria-label={t("status.running")}
		>
			<Loader2Icon
				className="size-3 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			<span className="tabular-nums">
				{counts.length > 0
					? counts.slice(0, 2).join(" · ")
					: t("status.running")}
			</span>
		</span>
	);
}
