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

/**
 * The most recent FINISHED job per connection row, for one project.
 *
 * The running-job map above goes empty the moment a scan ends, which is what
 * made a manual scan indistinguishable from a dead button: a run that examined
 * nothing finished too fast to render, left no trace on the row, and the only
 * visible number counted something else entirely. This keeps the finished run
 * addressable so a row can say what the last scan actually found.
 *
 * Shares the one `jobs.list` query the indicators already use — same query key,
 * so this adds no request.
 */
export function useProjectLastFinishedJob(projectId: string) {
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
				job.status === "RUNNING" ||
				job.projectId !== projectId ||
				!job.sourceId
			) {
				continue;
			}
			const key = `${job.sourceType}:${job.sourceId}`;
			const held = bySource.get(key);
			// `jobs.list` order is not guaranteed, so compare rather than
			// trusting first-seen.
			if (
				!held ||
				String(job.completedAt ?? "") > String(held.completedAt ?? "")
			) {
				bySource.set(key, job);
			}
		}
		return bySource;
	}, [data?.jobs, projectId, enabled]);
}
