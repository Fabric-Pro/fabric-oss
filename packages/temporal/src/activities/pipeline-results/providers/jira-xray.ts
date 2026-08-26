/**
 * Jira Xray → `NormalizedRun[]` mapper.
 *
 * Xray (Jira's test-management app) models automated results as **Test
 * Executions**: a Jira issue holding the run-level metadata (summary,
 * environment, revision, timestamps) and a list of per-Test **test runs**, each
 * carrying that test's outcome. This maps one Test Execution → one
 * `NormalizedRun` and each contained test run → one `NormalizedTestResult`, so
 * the shared linkage / status / persistence steps operate on Xray results
 * exactly as they do on GitHub Actions or Azure DevOps ones.
 *
 * The raw input types below are a minimal, provider-agnostic projection of what
 * Xray exposes — the Cloud GraphQL `getTestExecutions { … testRuns { … } }`
 * query and the equivalent REST / "Xray JSON" execution-import payload agree on
 * these fields (key, summary, environments, revision, timestamps; per-run test
 * key, status, start/finish, comment, defects). We take a payload someone has
 * already fetched; this module performs **no I/O** and imports no Prisma.
 *
 * ── Status tokens are project-configurable ──────────────────────────────────
 * Xray's default statuses are PASSED | FAILED | TODO | EXECUTING | ABORTED |
 * BLOCKED, but a Jira admin can rename them or add custom ones per project. So
 * this mapper does **not** interpret or convert the status — it passes the RAW
 * token straight through as `NormalizedTestResult.rawStatus`. The shared
 * `status-mapper.ts` owns the token → Fabric `TestResult` translation in one
 * tested place, and deliberately maps any UNRECOGNIZED token (a custom status,
 * TODO, EXECUTING, ABORTED, …) to `BLOCKED` — an ambiguous outcome reads as
 * "needs attention", never as green. Do not pre-map here.
 */

import type { NormalizedRun, NormalizedTestResult } from "../normalized-result";

const PROVIDER = "jira-xray";

/** One test's run within a Test Execution — an Xray `testRun`. */
export type XrayTestRun = {
	/** The linked Test issue's Jira key, e.g. `"PROJ-42"`. */
	testKey: string;
	/** The Test issue summary, when the query/payload included it. */
	testSummary?: string;
	/**
	 * The RAW Xray status token (default set: `PASSED` | `FAILED` | `TODO` |
	 * `EXECUTING` | `ABORTED` | `BLOCKED`, but project-configurable — see the
	 * module doc-comment). Passed through untouched as `rawStatus`.
	 */
	status: string;
	/** ISO-8601 start / finish of this individual run, when Xray recorded them. */
	startedOn?: string;
	finishedOn?: string;
	/** Execution comment for this test — surfaced as the failure message. */
	comment?: string;
	/** Linked defect issue keys, if any (no home in the normalized contract). */
	defects?: string[];
};

/** An Xray Test Execution issue and the per-test runs it recorded. */
export type XrayTestExecution = {
	/** The Test Execution issue key, e.g. `"PROJ-123"`. */
	key: string;
	/** Test Execution summary — the human-readable run name. */
	summary?: string;
	/** Xray "Test Environments" the execution ran against. */
	testEnvironments?: string[];
	/** Free-text build revision label, when set (not a git SHA). */
	revision?: string;
	/** Version / fixVersion label, when set. */
	version?: string;
	/** Self / browse URL of the Test Execution issue. */
	self?: string;
	/** ISO-8601 execution-level start / finish. */
	startedOn?: string;
	finishedOn?: string;
	/** The per-test runs within this execution. */
	testRuns: XrayTestRun[];
};

/** Parse an ISO-8601 timestamp to a `Date`, or `undefined` if absent/invalid. */
function toDate(iso: string | undefined): Date | undefined {
	if (!iso) {
		return undefined;
	}
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Elapsed ms between two ISO timestamps, or `undefined` if either is missing. */
function durationMsBetween(
	start: string | undefined,
	finish: string | undefined,
): number | undefined {
	const s = toDate(start);
	const f = toDate(finish);
	if (!s || !f) {
		return undefined;
	}
	const ms = f.getTime() - s.getTime();
	return ms >= 0 ? ms : undefined;
}

/** `"PROJ-42 Login succeeds"` when a summary is present, else the bare key. */
function testName(run: XrayTestRun): string {
	const summary = run.testSummary?.trim();
	return summary ? `${run.testKey} ${summary}` : run.testKey;
}

function mapTestRun(run: XrayTestRun): NormalizedTestResult {
	return {
		name: testName(run),
		// The test's Jira key doubles as the classname — a stable, rename-proof
		// handle for the linkage cascade's path/title tiers.
		classname: run.testKey,
		rawStatus: run.status,
		durationMs: durationMsBetween(run.startedOn, run.finishedOn),
		failureMessage: run.comment,
	};
}

/**
 * Map a fetched set of Xray Test Executions to the shared `NormalizedRun[]`.
 * Pure transform: no network, no database, no side effects.
 */
export function mapXrayToNormalizedRuns(input: {
	testExecutions: XrayTestExecution[];
}): NormalizedRun[] {
	return input.testExecutions.map((exec) => ({
		provider: PROVIDER,
		externalRunId: exec.key,
		pipelineName: exec.summary,
		// Xray has no first-class git ref on a Test Execution (`revision` is a
		// free-text label, not a SHA), so branch / commitSha stay undefined.
		runUrl: exec.self,
		startedAt: toDate(exec.startedOn),
		finishedAt: toDate(exec.finishedOn),
		durationMs: durationMsBetween(exec.startedOn, exec.finishedOn),
		results: exec.testRuns.map(mapTestRun),
	}));
}
