"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useSearchParams } from "next/navigation";

/**
 * The project a template page was opened from (`?projectId=`), with the
 * report suite on. Its links then lead back to that project's Reports tab
 * instead of the templates page the suite removes.
 */
export function useReportProjectContext(): string | undefined {
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");
	const projectId = useSearchParams().get("projectId");
	return reportSuite && projectId ? projectId : undefined;
}
