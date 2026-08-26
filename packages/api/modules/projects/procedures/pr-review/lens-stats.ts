/**
 * How often each review lens was WRONG, for one project.
 *
 * The feature states a target — under 20% false positives. What this first
 * computed was the DISMISSAL rate, and the docs called it the false-positive
 * rate anyway; they are not the same measurement. "Not worth acting on" also
 * covers a correct finding somebody chose not to fix, one that is out of scope,
 * and one already covered elsewhere. Dismissing now asks which, and only
 * INCORRECT counts here.
 *
 * Read from the judgement ledger rather than from the findings, because
 * re-running a lens deletes those — so the published figure used to be erased
 * by a button that costs nothing.
 *
 * Read-level permission: this is a summary of judgements the project's own
 * members made, and seeing it changes nothing.
 */

import {
	getPrReviewLensStats,
	PR_REVIEW_FALSE_POSITIVE_TARGET,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPrReviewEnabled } from "../../lib/pr-review-feature";

export const getPrReviewLensStatsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pull-request-review-stats",
		tags: ["Projects", "Test Cases"],
		summary: "How often each review lens was wrong, against the target",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => {
		assertPrReviewEnabled();

		// The target travels with the figure. It lived in two places — here and
		// again in the panel — and a threshold duplicated across a network
		// boundary is a threshold that will disagree with itself.
		return {
			lenses: await getPrReviewLensStats(input),
			target: PR_REVIEW_FALSE_POSITIVE_TARGET,
		};
	});
