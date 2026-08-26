/**
 * The commit range a failure happened in.
 *
 * "Correlating a failure against what changed" needs two commits, and a
 * `TestPipelineRun` records only one. The failing commit is the easy half — it
 * is on the run the finding was last seen in. The other half is a BASELINE: the
 * most recent run, on the same branch, where this same test passed. Everything
 * between those two commits is what could plausibly have broken it.
 *
 * Resolving the baseline from the test's OWN history rather than from "the last
 * green run" is the distinction that makes this useful. A pipeline where some
 * other test is flaky has no green runs at all, and a suite-level baseline would
 * quietly report no range for every failure in it — the projects that most need
 * this being exactly the ones it would go silent on.
 */

import { db } from "../../client";

export interface FailureCommitRange {
	/** Commit of the run where the test was last seen failing. */
	headSha: string;
	/** Commit of the most recent run on the same branch where it passed. */
	baseSha: string;
	branch: string | null;
	/** When the baseline ran, so a reader can judge how wide the range is. */
	baselineRunAt: Date | null;
}

/**
 * Why a range could not be resolved — reported rather than collapsed to `null`,
 * because "this provider never sends commits" and "this test has never passed"
 * are different problems and only one of them is worth acting on.
 */
export type FailureCommitRangeGap =
	| "NO_FAILING_RUN"
	| "NO_COMMIT_ON_RUN"
	| "NO_PASSING_BASELINE";

/**
 * Resolve the commit range for a finding.
 *
 * Scoped by `projectId` throughout: a finding id from another project resolves
 * to a gap rather than reading across the boundary.
 */
export async function getFailureCommitRange(input: {
	projectId: string;
	findingId: string;
}): Promise<
	{ range: FailureCommitRange } | { range: null; gap: FailureCommitRangeGap }
> {
	const finding = await db.testFinding.findFirst({
		where: {
			id: input.findingId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: { testName: true, classname: true, lastPipelineRunId: true },
	});
	if (!finding?.lastPipelineRunId) {
		return { range: null, gap: "NO_FAILING_RUN" };
	}

	const failingRun = await db.testPipelineRun.findFirst({
		where: { id: finding.lastPipelineRunId, projectId: input.projectId },
		select: { commitSha: true, branch: true, startedAt: true },
	});
	// Not every provider sends a commit — jira-xray deliberately does not — so a
	// missing sha is an ordinary outcome here, not a data error.
	if (!failingRun?.commitSha) {
		return { range: null, gap: "NO_COMMIT_ON_RUN" };
	}

	// The newest earlier run, on the same branch, that recorded this test as
	// passing. `results` is the ingested per-test payload; the test is matched on
	// the same (testName, classname) pair the finding fingerprint is built from,
	// so a rename correctly reads as "never passed" rather than silently
	// correlating against a different test's history.
	const candidates = await db.testPipelineRun.findMany({
		where: {
			projectId: input.projectId,
			branch: failingRun.branch,
			commitSha: { not: null },
			id: { not: finding.lastPipelineRunId },
			...(failingRun.startedAt
				? { startedAt: { lt: failingRun.startedAt } }
				: {}),
		},
		orderBy: { startedAt: "desc" },
		// Bounded: a project with a long history must not read its whole run
		// table to answer one triage question. Twenty runs back is far enough to
		// find a green one and near enough that the range stays reviewable — a
		// 200-commit range is not evidence, it is a changelog.
		take: 20,
		select: { commitSha: true, startedAt: true, results: true },
	});

	for (const candidate of candidates) {
		if (
			candidate.commitSha &&
			runRecordedTestAsPassed(candidate.results, finding)
		) {
			return {
				range: {
					headSha: failingRun.commitSha,
					baseSha: candidate.commitSha,
					branch: failingRun.branch,
					baselineRunAt: candidate.startedAt,
				},
			};
		}
	}
	return { range: null, gap: "NO_PASSING_BASELINE" };
}

/**
 * Did this run record the given test as passing?
 *
 * `results` is provider-ingested JSON, so every field is checked rather than
 * assumed. A run that does not mention the test at all is NOT a baseline: the
 * test may simply not have existed yet, and treating "absent" as "passing"
 * would correlate a failure against every commit since the suite was created.
 */
function runRecordedTestAsPassed(
	results: unknown,
	test: { testName: string; classname: string | null },
): boolean {
	if (!Array.isArray(results)) {
		return false;
	}
	return results.some((entry) => {
		if (typeof entry !== "object" || entry === null) {
			return false;
		}
		const row = entry as {
			name?: unknown;
			classname?: unknown;
			status?: unknown;
		};
		return (
			row.name === test.testName &&
			(row.classname ?? null) === test.classname &&
			row.status === "PASSED"
		);
	});
}
