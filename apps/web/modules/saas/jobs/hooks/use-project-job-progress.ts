"use client";

import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { useMemo } from "react";
import type { JobListItem } from "./use-jobs";
import { INLINE_ACTIVE_POLL_MS, useJobs } from "./use-jobs";

/**
 * Running jobs for one project, keyed by the connection row they belong to.
 *
 * Backed by the same `jobs.list` query the panel uses — one request feeds every
 * inline indicator on a settings page, instead of one query per repository or
 * channel row.
 *
 * Returns an empty map when `feature-inline-job-progress` is off, so the
 * indicators can be pulled back independently of the Job Hub itself.
 */
export function useProjectJobProgress(projectId: string) {
	const enabled = isMonitoringFeatureEnabled("feature-inline-job-progress");
	const { data } = useJobs(enabled, {
		projectId,
		activeIntervalMs: INLINE_ACTIVE_POLL_MS,
	});

	return useMemo(() => {
		const bySource = new Map<string, JobListItem>();
		if (!enabled) {
			return bySource;
		}
		for (const job of data?.jobs ?? []) {
			if (
				job.status !== "RUNNING" ||
				job.projectId !== projectId ||
				!job.sourceId
			) {
				continue;
			}
			bySource.set(`${job.sourceType}:${job.sourceId}`, job);
		}
		return bySource;
	}, [data?.jobs, projectId, enabled]);
}

/** Look up the running job for one connection row, if any. */
export function findJobForSource(
	jobs: Map<string, JobListItem>,
	sourceType: string,
	sourceId: string,
): JobListItem | undefined {
	return jobs.get(`${sourceType}:${sourceId}`);
}
