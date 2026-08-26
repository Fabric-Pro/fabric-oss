/**
 * The architecture review lens — the architecture lens.
 *
 * COMPUTED, not asked. Circular imports come from Tarjan over Atlas's import
 * graph; no model is involved at any point, including the wording. That is the
 * whole design and it is not a cost saving:
 *
 *   - a cycle either exists in the graph or it does not, so there is no
 *     false-positive rate to measure and the QA lens's <20% bar does not apply;
 *   - "does this module import that one" is exactly the question a model answers
 *     confidently and wrongly, and a wrong architecture finding is expensive —
 *     somebody goes looking for a cycle that is not there.
 *
 * If a future change wants prose here, it may only WORD a cycle this code already
 * proved. It must never be the thing that decides one exists.
 */

import { ORPCError } from "@orpc/client";
import { getPullRequestReview } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPrReviewEnabled } from "../../lib/pr-review-feature";
import { runArchitectureLens } from "../../lib/pr-review-lenses";

const ARCHITECTURE_LENS = "ARCHITECTURE";

/**
 * Cycles reported from one run. A repository that has let cycles accumulate can
 * have dozens, and listing them all against one pull request buries the ones that
 * pull request is actually implicated in.
 */
const MAX_CYCLES = 10;

/**
 * Declared-rule violations reported from one run, bounded for the same reason
 * cycles are: a repository that adopts a rule after the fact can breach it in
 * dozens of places, and listing them all against one pull request buries the
 * ones that pull request introduced.
 */
const MAX_VIOLATIONS = 10;

/**
 * How many members of a cycle to name in the finding title before summarising.
 * A 40-file knot's title has to stay readable; the full member list is in the
 * detail.
 */
const TITLE_MEMBERS = 3;

export const analysePullRequestArchitectureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pull-request-reviews/{id}/analyse-architecture",
		tags: ["Projects", "Test Cases"],
		summary: "Check a read pull request for circular imports",
	})
	.input(z.object({ projectId: z.string(), id: z.string() }))
	.handler(async ({ input, context }) => {
		assertPrReviewEnabled();

		// Refuse BEFORE any work: a lens a project switched off must not spend an
		// API call or a credit to discover it is off. `getProjectQaSettings` answers
		// with defaults for a project that never saved, so both lenses stay on until
		// somebody deliberately turns one off.
		const result = await runArchitectureLens({
			projectId: input.projectId,
			reviewId: input.id,
		});
		if (!result.indexed) {
			return {
				indexed: false as const,
				findings: [],
				cyclesInRepo: 0,
				cyclesTouched: 0,
			};
		}

		// Re-read for the audit metadata alone: the lens returns findings, and the
		// record has to name the repository and pull request they concern.
		const review = await getPullRequestReview({
			id: input.id,
			projectId: input.projectId,
		});
		if (!review) {
			throw new ORPCError("NOT_FOUND", {
				message: "That pull-request review was not found.",
			});
		}

		recordAuditFromRequest(context, {
			action: "project.pull_request.reviewed",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "pull_request_review", id: review.id },
			metadata: {
				lens: ARCHITECTURE_LENS,
				repository: `${review.repoOwner}/${review.repoName}`,
				prNumber: review.prNumber,
				headSha: review.headSha,
				findings: result.findings.length,
				// Both numbers, because their ratio is the interesting one: 40 cycles
				// in the repo and 1 touched says the change is fine and the repo is
				// not.
				cyclesInRepo: result.cyclesInRepo,
				cyclesTouched: result.cyclesTouched,
				// Same ratio logic: rules declared, breaches in the repo, and
				// breaches this change introduced are three different numbers.
				architectureRules: result.rulesDeclared,
				violationsInRepo: result.violationsInRepo,
				violationsTouched: result.violationsTouched,
				atlasAnalysisId: result.analysisId,
			},
		});

		return {
			indexed: true as const,
			findings: result.findings,
			cyclesInRepo: result.cyclesInRepo,
			cyclesTouched: result.cyclesTouched,
			violationsInRepo: result.violationsInRepo,
			violationsTouched: result.violationsTouched,
		};
	});
