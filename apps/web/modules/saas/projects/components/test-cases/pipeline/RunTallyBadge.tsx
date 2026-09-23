"use client";

import { Badge } from "@ui/components/badge";
import { useTranslations } from "next-intl";
import type { PipelineRun } from "./pipeline-run";

/**
 * A run's headline "passed/total" tally, shared by the run row and the run
 * detail sheet so both surfaces judge a run the same way.
 *
 * A run with no test data is neither a pass nor a failure. That is the normal
 * state between a webhook delivery (run metadata arrives at once) and the
 * sweep that fetches the per-test breakdown, and it is also what a pipeline
 * that died before its test step looks like. It renders muted and says so —
 * "0/0 passed" in green read as a clean run while the suite had failed.
 */
export function RunTallyBadge({
	run,
	className,
}: {
	run: Pick<PipelineRun, "totalCount" | "passedCount" | "failedCount">;
	className?: string;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");

	if (run.totalCount === 0) {
		return (
			<Badge variant="info" className={className}>
				{t("noTestResults")}
			</Badge>
		);
	}

	return (
		<Badge
			variant={run.failedCount > 0 ? "error" : "success"}
			className={className}
		>
			{run.passedCount}/{run.totalCount} {t("passed")}
		</Badge>
	);
}
