/**
 * Read a pull request and store the diff Fabric saw — phase 1 of the pull-request review work.
 *
 * Deliberately does NO analysis. The point of shipping this alone is that a
 * person can point Fabric at a real PR and see exactly what it read, before any
 * model is asked to draw conclusions from it. The review lenses land on top of
 * this, and inherit the ingest they can be checked against.
 *
 * Not a Temporal workflow: this is one bounded, user-initiated HTTP read plus a
 * write. The durable machinery exists for work that outlives a request, and a
 * diff fetch does not.
 */

import { ORPCError } from "@orpc/client";
import { getPullRequestReview, listPullRequestReviews } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPrReviewEnabled } from "../../lib/pr-review-feature";
import { readPullRequestIntoReview } from "../../lib/pr-review-read";

// The diff cap and the read itself live in `lib/pr-review-read.ts`, shared with
// the webhook. Re-exported here because callers and tests already import it from
// this module.
export { PR_REVIEW_MAX_DIFF_BYTES } from "../../lib/pr-review-read";

export const listPullRequestReviewsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pull-request-reviews",
		tags: ["Projects", "Test Cases"],
		summary: "Pull requests Fabric has read for this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPrReviewEnabled();
		return {
			reviews: await listPullRequestReviews({
				projectId: input.projectId,
				limit: input.limit,
			}),
		};
	});

export const getPullRequestReviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pull-request-reviews/{id}",
		tags: ["Projects", "Test Cases"],
		summary: "One pull-request read, including the diff Fabric saw",
	})
	.input(z.object({ projectId: z.string(), id: z.string() }))
	.handler(async ({ input }) => {
		assertPrReviewEnabled();
		const review = await getPullRequestReview({
			id: input.id,
			projectId: input.projectId,
		});
		if (!review) {
			throw new ORPCError("NOT_FOUND", {
				message: "That pull-request review was not found.",
			});
		}
		return review;
	});

export const readPullRequestProcedure = tenantProtectedProcedure
	// A write that spends an API call against the customer's own credential, so
	// it sits behind the QA surface's write permission rather than its read one.
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pull-request-reviews",
		tags: ["Projects", "Test Cases"],
		summary: "Read a pull request and store the diff",
	})
	// No `organizationId` in the input, deliberately. The owning org is a property
	// of the project, and a caller-supplied one would let somebody pair their own
	// project with another organization's id — `requireProjectPermission` would not
	// notice, because it authorizes the project and never looks at the org
	// (SOC 2 CC6.1/CC6.3, the ratchet in `input-org-unverified-ratchet.test.ts`).
	.input(
		z.object({
			projectId: z.string(),
			repositoryIntegrationId: z.string(),
			prNumber: z.number().int().positive(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPrReviewEnabled();

		// The read itself lives in `lib/pr-review-read.ts`, because the webhook
		// that reviews a pull request automatically has to do exactly this and a
		// second copy would drift. What stays here is what only a request has: the
		// person it is attributed to, and the audit record naming them.
		const { review, owner, repo, headSha } =
			await readPullRequestIntoReview({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				prNumber: input.prNumber,
				actingUserId: context.user.id,
			});

		// Audited because it reaches OUT of Fabric with the customer's credential
		// and pulls their source code in. Who asked for which PR, and when, is the
		// record that makes that answerable afterwards (SOC 2 CC7.2).
		recordAuditFromRequest(context, {
			action: "project.pull_request.read",
			category: "project",
			severity: "info",
			outcome: review.status === "READ" ? "success" : "failure",
			projectId: input.projectId,
			resource: { type: "pull_request_review", id: review.id },
			metadata: {
				repository: `${owner}/${repo}`,
				prNumber: input.prNumber,
				headSha,
				changedFiles: review.changedFiles,
				diffTruncated: review.diffTruncated,
			},
		});

		return review;
	});
