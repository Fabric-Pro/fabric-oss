/**
 * Put the lenses' findings back on the pull request they came from.
 *
 * Until now a review lived only in Fabric: somebody had to be in the app, on the
 * right project, on the right review, to learn that their change had an untested
 * branch. The people who need it are on the pull request.
 *
 * Three decisions worth stating, because each is the difference between a useful
 * comment and one a team mutes:
 *
 *  - **One comment per pull request, edited in place.** Recorded by id, with a
 *    marker in the body so a human can tell which comment is Fabric's. A review
 *    row is keyed by head commit, so the id is carried across pushes rather than
 *    looked up on the row — otherwise every push adds another comment.
 *  - **Nobody is surprised by it.** This procedure is the button; the webhook
 *    path posts the same comment for projects that switched automatic review on,
 *    per project and off by default. A comment appearing on someone's pull
 *    request that nobody asked for is the failure mode that gets a bot switched
 *    off, which is why the automatic half is opt-in rather than absent.
 *  - **Posted through the connection the review was read through.** The caller
 *    names a review, never a credential — so this cannot be pointed at a
 *    repository the project did not connect.
 *
 * Advisory, like everything else here: a comment blocks no merge, and GitHub has
 * no notion of a required check for it.
 */

import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { postReviewCommentForReview } from "../../lib/pr-review-comment";
import { assertPrReviewEnabled } from "../../lib/pr-review-feature";
// The body composer and the marker live in `lib/pr-review-comment.ts`, with the
// posting itself, because the webhook posts the same comment. They were copied
// here during that extraction and the copy was never called — but the tests
// imported it, so ten tests were pinning a duplicate that no request runs.
// Re-exported rather than re-declared: one definition, one thing to edit.

export const postPullRequestReviewCommentProcedure = tenantProtectedProcedure
	// Writes into the customer's repository under their credential, so it follows
	// the surface's write permission rather than its read one.
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pull-request-reviews/{id}/comment",
		tags: ["Projects", "Test Cases"],
		summary: "Post this review's findings back to the pull request",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			/** Where the reader lands from the comment. Optional: the caller knows
			 * the app's own URL shape, the server does not. */
			reviewUrl: z.string().url().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPrReviewEnabled();

		const result = await postReviewCommentForReview({
			projectId: input.projectId,
			reviewId: input.id,
			actingUserId: context.user.id,
			reviewUrl: input.reviewUrl ?? null,
		});

		recordAuditFromRequest(context, {
			action: "project.pull_request.comment_posted",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "pull_request_review", id: input.id },
			metadata: {
				// Which of the two it was, because "edited in place" is the property
				// that keeps a thread readable and the one worth noticing if it
				// stops happening.
				mode: result.updated ? "updated" : "created",
				findings: result.findings,
			},
		});

		return { url: result.url, updated: result.updated };
	});
