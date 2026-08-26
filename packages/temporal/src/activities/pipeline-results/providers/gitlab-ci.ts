/**
 * GitLab CI → `NormalizedRun[]` mapper.
 *
 * PURE transform only: it takes payloads a caller has ALREADY fetched from the
 * GitLab REST API and reshapes them to the provider-agnostic contract in
 * `../normalized-result`. It does not call the API, read Prisma, or touch any
 * I/O — so it is trivially unit-testable and workflow-safe.
 *
 * Two source payloads feed it:
 *   - Pipelines — `GET /projects/:id/pipelines` (list) and
 *     `GET /projects/:id/pipelines/:pipeline_id` (detail). One → one
 *     `NormalizedRun`.
 *   - Per-pipeline test report — `GET /projects/:id/pipelines/:pipeline_id/test_report`,
 *     keyed by pipeline id. Each `test_case` → one `NormalizedTestResult`. A
 *     pipeline with no report entry yields `results: []`.
 *
 * Raw per-test outcome tokens are passed through as `rawStatus`; the shared
 * `status-mapper` is what turns them into a Fabric `TestResult`, so this file
 * never decides pass/fail — it only reshapes.
 */

import type { NormalizedRun, NormalizedTestResult } from "../normalized-result";

/** The provider tag stamped on every run this mapper emits. */
const PROVIDER = "gitlab-ci";

/**
 * A GitLab CI pipeline — the subset of `GET /projects/:id/pipelines[/:id]` this
 * mapper reads. `status` is one of GitLab's pipeline states
 * (success/failed/canceled/skipped/manual/running/pending/created/…); kept as a
 * plain string so an unseen state never breaks the transform. `duration` is in
 * seconds and null until the pipeline has run. `name` (GitLab 16.3+ pipeline
 * names) is optional and preferred over `ref` for display.
 */
export type GitlabPipeline = {
	id: number;
	name?: string | null;
	ref: string;
	sha: string;
	web_url: string;
	status: string;
	created_at: string;
	updated_at: string;
	duration: number | null;
	/**
	 * Who triggered the pipeline. Present on the single-pipeline detail
	 * (`GET /projects/:id/pipelines/:id`), NOT on the list — the fetcher pulls
	 * the detail so this is populated. `username` is the stable handle.
	 */
	user?: {
		username?: string | null;
		name?: string | null;
		avatar_url?: string | null;
	} | null;
};

/** One `test_case` inside a suite of a GitLab pipeline test report. */
export type GitlabTestCase = {
	name: string;
	classname?: string;
	/** GitLab's per-test outcome: success | failed | skipped | error. */
	status: string;
	/** Seconds spent on the test. */
	execution_time?: number | null;
	/** Captured stdout/stderr; carries the failure detail on a failed case. */
	system_output?: string | null;
};

/** One `test_suite` grouping test cases in a GitLab pipeline test report. */
export type GitlabTestSuite = {
	name?: string;
	test_cases?: GitlabTestCase[];
};

/**
 * A GitLab pipeline test report —
 * `GET /projects/:id/pipelines/:pipeline_id/test_report`. Only `test_suites` is
 * read here; the `*_count` rollups are derivable and left out.
 */
export type GitlabTestReport = {
	total_count?: number;
	test_suites?: GitlabTestSuite[];
};

/** Seconds → milliseconds, dropping missing/null durations to `undefined`. */
function secondsToMs(seconds: number | null | undefined): number | undefined {
	return typeof seconds === "number" ? seconds * 1000 : undefined;
}

/** Parse an ISO-8601 timestamp to a `Date`, or `undefined` when absent. */
function toDate(iso: string | null | undefined): Date | undefined {
	return iso ? new Date(iso) : undefined;
}

/** Flatten a report's suites → a flat list of normalized per-test results. */
function mapTestReport(report: GitlabTestReport): NormalizedTestResult[] {
	const results: NormalizedTestResult[] = [];
	for (const suite of report.test_suites ?? []) {
		for (const tc of suite.test_cases ?? []) {
			results.push({
				name: tc.name,
				classname: tc.classname,
				// Pass the GitLab token through untouched — the shared status
				// mapper is the single place that classifies it.
				rawStatus: tc.status,
				durationMs: secondsToMs(tc.execution_time),
				failureMessage: tc.system_output || undefined,
			});
		}
	}
	return results;
}

/**
 * Map fetched GitLab pipelines (and their optional test reports) to the shared
 * `NormalizedRun[]` contract. Pure — no side effects, no I/O.
 */
export function mapGitlabCiToNormalizedRuns(input: {
	pipelines: GitlabPipeline[];
	testReportByPipelineId?: Record<string, GitlabTestReport>;
}): NormalizedRun[] {
	const { pipelines, testReportByPipelineId } = input;

	return pipelines.map((pipeline): NormalizedRun => {
		const externalRunId = String(pipeline.id);
		const report = testReportByPipelineId?.[externalRunId];

		return {
			provider: PROVIDER,
			externalRunId,
			pipelineName: pipeline.name || pipeline.ref,
			branch: pipeline.ref,
			commitSha: pipeline.sha,
			runUrl: pipeline.web_url,
			status: pipeline.status,
			triggeredByActor:
				pipeline.user?.username ?? pipeline.user?.name ?? undefined,
			triggeredByActorAvatarUrl: pipeline.user?.avatar_url ?? undefined,
			// The list/detail payloads expose created_at/updated_at; use them as
			// the run's start and last-transition (completion proxy) timestamps.
			startedAt: toDate(pipeline.created_at),
			finishedAt: toDate(pipeline.updated_at),
			durationMs: secondsToMs(pipeline.duration),
			results: report ? mapTestReport(report) : [],
		};
	});
}
