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
	// Name the step that is running, and show the latest counters: the early
	// ones stop moving once their step is done.
	const runningStep = job.steps.find((step) => step.status === "running");
	const parts = [
		...(runningStep ? [t(`steps.${runningStep.key}`)] : []),
		...counts.slice(-2),
	];

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
				{parts.length > 0 ? parts.join(" · ") : t("status.running")}
			</span>
		</span>
	);
}
