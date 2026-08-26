import { db } from "../../client";

/**
 * The badge number on each section of the Testing tab.
 *
 * `plans`, `runs` and `pullRequests` are totals — "how much is here". `cases`
 * is also a total, matching the list's own unfiltered count. `questions` is
 * deliberately OPEN-only: an answered question is finished work, and a badge
 * that keeps counting it never goes down, so it stops meaning anything. Same
 * reasoning for `uncoveredFeatures` — the coverage section exists to close
 * gaps, so the gap count is the number worth carrying.
 */
export type TestingSectionCounts = {
	cases: number;
	plans: number;
	/** Work items with no live test case linked — the coverage gap. */
	uncoveredFeatures: number;
	runs: number;
	pullRequests: number;
	/** OPEN questions only. */
	questions: number;
};

/**
 * Every section count in ONE round trip.
 *
 * Six independent queries fired from six panels would each pay their own
 * latency and each be cached separately, so the badges could disagree with one
 * another on screen. Issued together they share a tick and a cache entry — and
 * each is a `count` over an indexed `projectId`, never a row fetch.
 */
export async function getTestingSectionCounts(
	projectId: string,
): Promise<TestingSectionCounts> {
	// Soft-deleted rows are excluded everywhere they can exist. A badge counting
	// deleted cases reads as a list that lost rows on the way to the screen.
	const live = { projectId, deletedAt: null };

	const [cases, plans, uncoveredFeatures, runs, pullRequests, questions] =
		await Promise.all([
			db.testCase.count({ where: live }),
			db.testPlan.count({ where: live }),
			db.userStory.count({
				where: {
					projectId,
					// `none` over the link table, not a zero-count rollup: the
					// coverage list defines "uncovered" as having no LIVE case
					// linked, and re-deriving it from a tally here is how the
					// badge and the list start disagreeing. A story whose only
					// linked case was deleted is uncovered again.
					testCaseLinks: { none: { testCase: live } },
				},
			}),
			db.testPipelineRun.count({ where: live }),
			db.pullRequestReview.count({ where: { projectId } }),
			db.qaOpenQuestion.count({ where: { projectId, status: "OPEN" } }),
		]);

	return { cases, plans, uncoveredFeatures, runs, pullRequests, questions };
}
