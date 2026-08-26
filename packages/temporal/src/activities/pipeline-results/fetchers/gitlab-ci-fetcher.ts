/**
 * GitLab CI pipeline-result fetcher. Pulls recent finished
 * pipelines from a connected GitLab project and their native test reports, then
 * normalizes via the shared GitLab mapper. Unlike GitHub, GitLab parses the
 * JUnit artifacts server-side and exposes them as JSON
 * (`/pipelines/:id/test_report`), so there is no zip/XML handling here.
 * Incremental: only pipelines newer than the stored cursor (highest ingested
 * pipeline id) are fetched.
 *
 * GitLab REST access is injected as {@link GitlabClient} so auth lives outside
 * this fetch. A pipeline whose report is missing/expired ingests as a run-level
 * record with `results: []` (GitLab answers 200 + empty suites, or the per-
 * pipeline fetch is swallowed) — the pipeline's pass/fail is still preserved.
 */

import { safeHeartbeat } from "../../lib/activity-liveness";
import type { NormalizedRun } from "../normalized-result";
import {
	type GitlabPipeline,
	type GitlabTestReport,
	mapGitlabCiToNormalizedRuns,
} from "../providers/gitlab-ci";
import { advanceCursor } from "./cursor";
import { paginateRuns } from "./paginate";

/** Minimal GitLab REST access the fetcher needs (GET a path under the base). */
export interface GitlabClient {
	get<T = unknown>(path: string): Promise<T>;
}

export interface GitlabFetchInput {
	/** The project's full path (`group/subgroup/project`) or numeric id. */
	projectPath: string;
	/** Restrict to pipelines on this branch/tag (the connected default), when set. */
	ref?: string;
	/** Incremental cursor: only pipelines with `id` greater than this are pulled. */
	sincePipelineId?: number | null;
	/** How many recent pipelines to scan per fetch (the list is newest-first). */
	maxRuns?: number;
}

export interface GitlabFetchResult {
	runs: NormalizedRun[];
	/** Highest pipeline id seen — the caller stores it as the next cursor. */
	newCursor: number | null;
	/** True when the page cap stopped paging before reaching the cursor. */
	truncated?: boolean;
}

/** A pipeline is worth a test-report fetch only once it has finished running. */
const FINISHED_STATUSES = new Set(["success", "failed"]);

/**
 * Fetch + normalize new GitLab CI pipelines. Lists recent pipelines newest-
 * first, keeps the finished ones past the cursor, pulls each one's native test
 * report, and maps to `NormalizedRun`. Pipelines are returned oldest-first so
 * ingestion order is chronological and the cursor advances monotonically. A
 * single pipeline's report failure is swallowed (that pipeline ingests run-
 * level-only) so one bad report never fails the whole fetch.
 */
export async function fetchGitlabCiRuns(
	client: GitlabClient,
	input: GitlabFetchInput,
): Promise<GitlabFetchResult> {
	const perPage = input.maxRuns ?? 20;
	const project = encodeURIComponent(input.projectPath);
	const since = input.sincePipelineId ?? 0;

	const refParam = input.ref ? `&ref=${encodeURIComponent(input.ref)}` : "";
	// Page back to the cursor rather than taking one newest-first page: a backlog
	// bigger than one page would otherwise lose everything below the newest page
	// once the cursor advanced past it.
	const { items: list, truncated } = await paginateRuns<GitlabPipeline>({
		since,
		perPage,
		idOf: (p) => p.id,
		onPage: (page) => safeHeartbeat({ phase: "gitlab-list", page }),
		fetchPage: async (page) => {
			const batch = await client.get<GitlabPipeline[]>(
				`/projects/${project}/pipelines?order_by=id&sort=desc&per_page=${perPage}&page=${page}${refParam}`,
			);
			return Array.isArray(batch) ? batch : [];
		},
	});

	// Only FINISHED pipelines are candidates. Pipelines still running are tracked
	// separately so `advanceCursor` can hold the cursor below the oldest of them:
	// a concurrently-running pipeline can have a LOWER id than a newer finished
	// one, and advancing past it would skip its results once it completes.
	const listed = list.filter((p) => p.id > since);
	const candidates = listed
		.filter((p) => FINISHED_STATUSES.has(p.status))
		.sort((a, b) => a.id - b.id);
	const inFlightIds = listed
		.filter((p) => !FINISHED_STATUSES.has(p.status))
		.map((p) => p.id);

	const testReportByPipelineId: Record<string, GitlabTestReport> = {};
	// Pipelines enriched with their single-pipeline detail — the list entry omits
	// `user` (who triggered) + `name` + `duration`, which only the detail carries.
	const enriched: GitlabPipeline[] = [];
	const ingestedIds: number[] = [];

	for (const pipeline of candidates) {
		// Two round trips per pipeline (detail + test report); check in per
		// pipeline so a long candidate list cannot starve the heartbeat.
		safeHeartbeat({ phase: "gitlab-pipeline", pipelineId: pipeline.id });
		// Pull the pipeline detail for `user`/`name`/`duration`. A failure here is
		// non-fatal: fall back to the list entry (loses only the "run by" actor).
		let detailed = pipeline;
		try {
			const detail = await client.get<GitlabPipeline>(
				`/projects/${project}/pipelines/${pipeline.id}`,
			);
			if (detail) {
				detailed = { ...pipeline, ...detail };
			}
		} catch (err) {
			console.warn("[pipeline-gitlab] pipeline detail fetch failed", {
				projectPath: input.projectPath,
				pipelineId: pipeline.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		enriched.push(detailed);

		try {
			const report = await client.get<GitlabTestReport>(
				`/projects/${project}/pipelines/${pipeline.id}/test_report`,
			);
			// GitLab answers 200 + empty suites when a pipeline has no report; only
			// record entries that actually carry suites so the mapper yields [].
			if (report?.test_suites && report.test_suites.length > 0) {
				testReportByPipelineId[String(pipeline.id)] = report;
			}
		} catch (err) {
			// A missing/forbidden report for one pipeline must not sink the whole
			// sync; the pipeline still ingests as a run-level record (results: []).
			console.warn(
				"[pipeline-gitlab] test report fetch failed for pipeline",
				{
					projectPath: input.projectPath,
					pipelineId: pipeline.id,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
		ingestedIds.push(pipeline.id);
	}

	const newCursor = advanceCursor({ since, ingestedIds, inFlightIds });

	return {
		runs: mapGitlabCiToNormalizedRuns({
			pipelines: enriched,
			testReportByPipelineId,
		}),
		newCursor: newCursor || null,
		truncated,
	};
}
