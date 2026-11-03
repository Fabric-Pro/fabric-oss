/**
 * Project re-chunk (spec 2026-10-28 §8a): started when someone saves a
 * chunking change. Re-chunks every source behind the project's chunking
 * version, a few at a time, writing new points before removing old ones.
 *
 * One re-chunk per project: the API starts it under a per-project workflow id
 * with TERMINATE_EXISTING, so a newer change supersedes a running one. A run
 * that finds the project already at a newer version stops as SUPERSEDED
 * without writing anything.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_EMBEDDING_TASK_QUEUE } from "../task-queues";

export interface ProjectRechunkWorkflowInput {
	projectId: string;
	organizationId: string;
	userId: string;
	runId: string;
	chunkingVersion: number;
}

export interface ProjectRechunkWorkflowOutput {
	status: "COMPLETED" | "FAILED" | "SUPERSEDED";
	total: number;
	done: number;
	failed: number;
	skipped: number;
}

/** Sources re-chunked in parallel; embedding providers rate-limit beyond this. */
const RECHUNK_CONCURRENCY = 4;

const {
	listRechunkSourcesActivity,
	rechunkProjectSourceActivity,
	recordProjectRechunkProgressActivity,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function projectRechunkWorkflow(
	input: ProjectRechunkWorkflowInput,
): Promise<ProjectRechunkWorkflowOutput> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		runId: input.runId,
		chunkingVersion: input.chunkingVersion,
	};

	const sources = await listRechunkSourcesActivity(scope);
	const queue: Array<{ source: "context" | "document"; sourceId: string }> = [
		...sources.contextIds.map((sourceId) => ({
			source: "context" as const,
			sourceId,
		})),
		...sources.documentIds.map((sourceId) => ({
			source: "document" as const,
			sourceId,
		})),
	];
	const counts = { total: queue.length, done: 0, failed: 0, skipped: 0 };

	if (!sources.current) {
		await recordProjectRechunkProgressActivity({
			runId: input.runId,
			...counts,
			finalStatus: "SUPERSEDED",
		});
		return { status: "SUPERSEDED", ...counts };
	}

	let superseded = false;
	let lastError: string | undefined;
	for (let i = 0; i < queue.length && !superseded; i += RECHUNK_CONCURRENCY) {
		const batch = queue.slice(i, i + RECHUNK_CONCURRENCY);
		// A source whose activity fails after its retries (a timeout, a
		// crashed worker) counts as failed; it keeps its old points and the
		// run goes on, so the run never stays RUNNING with nobody working it.
		const outcomes = await Promise.all(
			batch.map((item) =>
				rechunkProjectSourceActivity({ ...scope, ...item }).catch(
					(error: unknown) => ({
						outcome: "failed" as const,
						error:
							error instanceof Error
								? error.message
								: String(error),
					}),
				),
			),
		);
		for (const { outcome, error } of outcomes) {
			if (outcome === "rechunked") {
				counts.done++;
			} else if (outcome === "skipped") {
				counts.skipped++;
			} else if (outcome === "failed") {
				counts.failed++;
				lastError = error ?? lastError;
			} else {
				superseded = true;
			}
		}
		await recordProjectRechunkProgressActivity({
			runId: input.runId,
			...counts,
		});
	}

	const status = superseded
		? "SUPERSEDED"
		: counts.failed > 0 && counts.done === 0 && counts.total > 0
			? "FAILED"
			: "COMPLETED";
	await recordProjectRechunkProgressActivity({
		runId: input.runId,
		...counts,
		finalStatus: status,
		error: lastError,
	});
	return { status, ...counts };
}
