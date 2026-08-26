"use client";

import { useTenantQuery } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";

/** Cadence while at least one job is running — the spec's "≤ 5 seconds" bound. */
const ACTIVE_POLL_MS = 2_500;
/**
 * Cadence for the inline connection-row indicators. Slower than the panel's
 * because those indicators are ambient — they live on a settings page the user
 * may leave open for a long time — and still inside the spec's bound.
 */
const INLINE_ACTIVE_POLL_MS = 5_000;
/** Cadence when everything on screen is finished; the panel is just history. */
const IDLE_POLL_MS = 30_000;

export type JobStepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	/** The job finished without reaching this step. */
	| "skipped";

export interface JobStep {
	key: string;
	status: JobStepStatus;
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

export interface JobListItem {
	id: string;
	kind: string;
	status: "RUNNING" | "COMPLETED" | "FAILED";
	title: string;
	sourceType: string | null;
	sourceId: string | null;
	counts: Record<string, number>;
	steps: JobStep[];
	error: string | null;
	/** e.g. "TimedOut", "Superseded" — distinguishes a watchdog close from a real failure. */
	errorClass?: string | null;
	projectId: string;
	projectName: string;
	startedAt: string;
	completedAt: string | null;
}

interface JobListResponse {
	jobs: JobListItem[];
	retentionDays: number;
}

/**
 * Active + recent background jobs for the current workspace.
 *
 * Only polls while the panel is open, and only fast while something is actually
 * running: an idle workspace costs one request every 30s, and a busy one
 * refreshes inside the spec's real-time bound. `enabled` is what keeps the
 * fast interval from running against a closed panel.
 */
export function useJobs(
	enabled: boolean,
	opts?: {
		/**
		 * Only speed up for jobs belonging to this project. The panel is
		 * workspace-wide and wants the fast cadence for anything running, but
		 * the inline indicators are on a project's settings page — polling every
		 * 2.5s there because an unrelated repository is indexing elsewhere in
		 * the workspace is pure waste.
		 */
		projectId?: string;
		activeIntervalMs?: number;
	},
) {
	const activeInterval = opts?.activeIntervalMs ?? ACTIVE_POLL_MS;
	const projectId = opts?.projectId;

	return useTenantQuery<JobListResponse>({
		baseKey: ["jobs", "list"],
		queryFn: (organizationId) =>
			orpcClient.jobs.list({
				organizationId,
			}) as Promise<JobListResponse>,
		enabled,
		refetchOnWindowFocus: true,
		refetchInterval: (query) =>
			query.state.data?.jobs.some(
				(job) =>
					job.status === "RUNNING" &&
					(!projectId || job.projectId === projectId),
			)
				? activeInterval
				: IDLE_POLL_MS,
		staleTime: 0,
	});
}

export { INLINE_ACTIVE_POLL_MS };
