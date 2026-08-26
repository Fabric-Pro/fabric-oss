/**
 * GitHub Actions → `NormalizedRun[]` mapper.
 *
 * Pure transform: takes the native workflow-run payload (from
 * `GET /repos/{owner}/{repo}/actions/runs`) plus any per-run JUnit reports the
 * fetcher already downloaded + parsed, and produces the provider-agnostic shape
 * the linkage / status / persistence steps operate on. No network, no Prisma —
 * the caller owns fetching; this file only reshapes. Mirrors the sibling
 * `status-mapper.ts` / `automation-linkage.ts`: one shared, testable step per
 * concern.
 *
 * GitHub run metadata gives the run-level record; per-test outcomes come from
 * JUnit XML test-report artifacts (GitHub Actions has no first-class per-test
 * API — teams upload `junit.xml` via `actions/upload-artifact`). A run with no
 * JUnit artifact still ingests as a run-level record with `results: []`.
 */

import type { NormalizedRun, NormalizedTestResult } from "../normalized-result";

/**
 * A GitHub Actions workflow run, as returned in the `workflow_runs[]` array of
 * `GET /repos/{owner}/{repo}/actions/runs`. Only the fields this mapper reads
 * are modeled — the real object carries ~40 more.
 * @see https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository
 */
export type GithubWorkflowRun = {
	id: number;
	name?: string | null;
	/** Branch the run was triggered on; null for tag / detached-HEAD runs. */
	head_branch?: string | null;
	head_sha: string;
	html_url: string;
	/** Lifecycle state: "queued" | "in_progress" | "completed" | … */
	status?: string | null;
	/**
	 * Terminal outcome — null until the run completes: "success" | "failure" |
	 * "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" |
	 * "stale".
	 */
	conclusion?: string | null;
	/** ISO-8601; when the run actually began executing. */
	run_started_at?: string | null;
	/** ISO-8601; last update — the finish time for a completed run. */
	updated_at?: string | null;
	/**
	 * The account that caused the LATEST run attempt (e.g. whoever hit "re-run").
	 * Preferred over {@link actor} (the original triggerer) so "run by" reflects
	 * who produced the results we're ingesting.
	 */
	triggering_actor?: {
		login?: string | null;
		avatar_url?: string | null;
	} | null;
	/** The account that first triggered the run — fallback for `triggering_actor`. */
	actor?: { login?: string | null; avatar_url?: string | null } | null;
};

/**
 * One `<testcase>` from a JUnit report, pre-parsed by the fetcher into a flat
 * shape (the fetcher derives `status` from the presence of a `<failure>` /
 * `<error>` / `<skipped>` child element).
 */
export type JUnitTestCase = {
	name: string;
	/** JUnit `<testcase classname>` — the describe block / spec file. */
	classname?: string;
	/** JUnit `time` attribute, in SECONDS (as in the XML). */
	time?: number;
	status: "passed" | "failed" | "skipped" | "error";
	/** Text of the first `<failure>` / `<error>`, when the test did not pass. */
	failureMessage?: string;
};

/** One `<testsuite>` from a JUnit report. */
export type JUnitSuite = {
	name: string;
	testcases: JUnitTestCase[];
};

/** Parse an ISO-8601 timestamp to a Date, or `undefined` if absent/invalid. */
function toDate(iso: string | null | undefined): Date | undefined {
	if (!iso) {
		return undefined;
	}
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** JUnit `<testcase>` → the shared per-test shape (raw status kept for the mapper). */
function mapJUnitCase(tc: JUnitTestCase): NormalizedTestResult {
	return {
		name: tc.name,
		classname: tc.classname,
		rawStatus: tc.status,
		durationMs: typeof tc.time === "number" ? tc.time * 1000 : undefined,
		failureMessage: tc.failureMessage,
	};
}

/**
 * Map GitHub Actions workflow runs (+ any JUnit reports keyed by run id) to
 * `NormalizedRun[]`. One workflow run → one `NormalizedRun`; its `results` are
 * the flattened testcases of `junitByRunId[String(run.id)]`, or `[]` when the
 * run has no JUnit data.
 */
export function mapGithubActionsToNormalizedRuns(input: {
	workflowRuns: GithubWorkflowRun[];
	junitByRunId?: Record<string, JUnitSuite[]>;
}): NormalizedRun[] {
	const { workflowRuns, junitByRunId } = input;

	return workflowRuns.map((run) => {
		const externalRunId = String(run.id);
		const startedAt = toDate(run.run_started_at);
		const finishedAt = toDate(run.updated_at);
		const suites = junitByRunId?.[externalRunId] ?? [];
		const actor = run.triggering_actor ?? run.actor;

		return {
			provider: "github-actions",
			externalRunId,
			pipelineName: run.name ?? undefined,
			branch: run.head_branch ?? undefined,
			commitSha: run.head_sha,
			runUrl: run.html_url,
			// conclusion is authoritative once set; fall back to the lifecycle
			// status for a still-running / queued run (no conclusion yet).
			status: run.conclusion ?? run.status ?? undefined,
			triggeredByActor: actor?.login ?? undefined,
			triggeredByActorAvatarUrl: actor?.avatar_url ?? undefined,
			startedAt,
			finishedAt,
			durationMs:
				startedAt && finishedAt
					? finishedAt.getTime() - startedAt.getTime()
					: undefined,
			results: suites.flatMap((suite) =>
				suite.testcases.map(mapJUnitCase),
			),
		};
	});
}
