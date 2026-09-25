import { logger } from "@repo/logs";

/**
 * Kick a planning analysis when a topic is SELECTED, so it is usually running
 * before anybody opens the page. Usually, not always: a page opened straight
 * after the change can get there first, and its own start then races this one.
 * Attempts are claimed under a Project-row lock and a partial unique index over
 * GENERATING rows, so while one is GENERATING the other is refused and at most
 * one runs — unless this start stalls between its existence check and its
 * claim for as long as a whole run takes, finds nothing GENERATING, and starts
 * a second.
 *
 * "As soon as the user clicks selected, then do the analysis — they don't even
 * have to open this page. So theoretically they could select a few, and by the
 * time they get in there that analysis is complete."
 *
 * The trigger used to be the Planning & Analysis tab's own mount, which meant
 * two things: nothing ran until somebody clicked through to the third tab, and
 * the reader who never did got an empty questions panel with no explanation.
 *
 * FIRE AND FORGET, deliberately. Marking a topic Selected is the user's action
 * and it succeeded; a Temporal outage must not turn that into a failed status
 * change. The page-mount fallback is what makes that safe — a topic this
 * leaves with no attempt at all is tried again when somebody who can edit it
 * opens it. One this did claim is not: an attempt that failed, or was left
 * GENERATING by a continuation killed mid-start, waits for a person to retry
 * it, because both page auto-starts skip any existing attempt.
 *
 * The caller keeps it fire-and-forget: `update-topic-status.ts` hands this
 * promise to `runInBackground` once the status write has resolved. Never
 * awaited, because the status response must not wait on Temporal; never a bare
 * `void`, because on Vercel a floating promise is not guaranteed to finish once
 * the response has been sent.
 */
const MAX_CONCURRENT_ANALYSES_PER_PROJECT = 5;

export async function autoStartPlanningAnalysis(input: {
	projectId: string;
	topicId: string;
	requestedById: string;
}): Promise<void> {
	try {
		const { db } = await import("@repo/database");

		// Already has one, or already running one. `startPlanningAnalysisAttempt`
		// would refuse anyway; asking first keeps a bulk selection from firing
		// N pointless writes at a partial unique index.
		const existing = await db.publishingTopicPlanningAnalysis.findFirst({
			where: { topicId: input.topicId, projectId: input.projectId },
			select: { id: true },
		});
		if (existing) {
			return;
		}

		/**
		 * A bound, not a queue — and the difference is worth stating.
		 *
		 * Selecting ten topics would otherwise start ten model runs at once.
		 * Above this many in flight for one project, the auto-start declines and
		 * the topic simply has no analysis yet; opening it starts one. So the
		 * work drains as the reader actually reaches each topic, which is the
		 * order they care about, rather than in the order they happened to tick
		 * checkboxes.
		 *
		 * No hard cap on the total: "no one will pick 100 and run it", and a cap
		 * that refused outright would strand a topic with no way back except a
		 * manual click the reader has no reason to expect.
		 */
		const inFlight = await db.publishingTopicPlanningAnalysis.count({
			where: { projectId: input.projectId, status: "GENERATING" },
		});
		if (inFlight >= MAX_CONCURRENT_ANALYSES_PER_PROJECT) {
			return;
		}

		const { startPlanningAnalysisRun } = await import(
			"../procedures/publishing-suite/planning-analysis"
		);
		await startPlanningAnalysisRun({
			projectId: input.projectId,
			topicId: input.topicId,
			requestedById: input.requestedById,
		});
	} catch (error) {
		// Never surfaced. The status change is what the user asked for and it
		// has already happened; the analysis is an optimisation on top of it.
		logger.warn("[publishing-suite] auto-start analysis failed", {
			topicId: input.topicId,
			err: error instanceof Error ? error.message : String(error),
		});
	}
}
