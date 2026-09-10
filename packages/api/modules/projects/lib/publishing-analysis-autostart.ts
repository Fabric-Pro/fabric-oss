import { logger } from "@repo/logs";

/**
 * Kick a planning analysis when a topic is SELECTED, so it is running before
 * anybody opens the page.
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
 * change. The page-mount fallback is what makes that safe — anything not
 * started here starts when somebody opens the topic.
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
