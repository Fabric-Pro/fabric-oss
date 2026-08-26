/**
 * Run the QA review lens over a pull request Fabric already read — the pull-request review work
 * phase 2.
 *
 * Separate from the read (`read-pull-request.ts`) on purpose. The read is a fact
 * and costs an API call; this is a judgement and costs credits. Keeping them
 * apart means re-reading a PR after a new commit does not silently re-bill an
 * analysis nobody asked for, and a person can look at the diff before deciding
 * whether an opinion about it is worth paying for.
 */

import { ORPCError } from "@orpc/client";
import {
	getPullRequestReview,
	setPullRequestReviewFindingStatus,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPrReviewEnabled } from "../../lib/pr-review-feature";
import { runQaLens } from "../../lib/pr-review-lenses";

/** The lens this procedure owns. Phase 3 adds ARCHITECTURE beside it. */
const QA_LENS = "QA";

export const analysePullRequestQaProcedure = tenantProtectedProcedure
	// Spends model credits against the tenant, so it sits behind the QA surface's
	// write permission rather than its read one.
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pull-request-reviews/{id}/analyse-qa",
		tags: ["Projects", "Test Cases"],
		summary: "Review a read pull request for test coverage",
	})
	.input(z.object({ projectId: z.string(), id: z.string() }))
	.handler(async ({ input, context }) => {
		assertPrReviewEnabled();

		// Refuse BEFORE any work: a lens a project switched off must not spend an
		// API call or a credit to discover it is off. `getProjectQaSettings` answers
		// with defaults for a project that never saved, so both lenses stay on until
		// somebody deliberately turns one off.
		const result = await runQaLens({
			projectId: input.projectId,
			reviewId: input.id,
			userId: context.user.id,
			// The project's own tenant, resolved by the lens from the project.
			// Deliberately not taken from the caller — see the ratchet in
			// `input-org-unverified-ratchet.test.ts`.
			organizationId: null,
		});
		if (!result.configured) {
			// Null is the "no AI provider configured" state, not a failure.
			// Returned as data so the panel renders a soft hint, not a red error.
			return { configured: false as const, findings: [], dropped: 0 };
		}
		const findings = result.findings;

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
				lens: QA_LENS,
				repository: `${review.repoOwner}/${review.repoName}`,
				prNumber: review.prNumber,
				headSha: review.headSha,
				findings: findings.length,
				// How many the grounding filter threw away. Recorded because a run
				// that drops most of what it produced is the earliest signal that the
				// prompt or the model has drifted, and it is invisible from the
				// finding list alone.
				droppedUngrounded: result.dropped,
				model: result.model,
			},
		});

		return { configured: true as const, findings, dropped: result.dropped };
	});

export const setPullRequestFindingStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/pull-request-review-findings/{id}",
		tags: ["Projects", "Test Cases"],
		summary: "Accept or dismiss a pull-request review finding",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			// Plain strings, matching the column. The set is small and closed here
			// even though the column is not, so an unknown value is rejected at the
			// edge rather than stored.
			status: z.enum(["OPEN", "ACCEPTED", "DISMISSED"]),
			// Why it was dismissed. The success criterion is a FALSE-POSITIVE
			// rate, and only INCORRECT is one: the other three are reasons a
			// CORRECT finding was not acted on. Without this the two figures were
			// the same number under two names.
			dismissalReason: z
				.enum([
					"INCORRECT",
					"WONT_FIX",
					"OUT_OF_SCOPE",
					"ALREADY_COVERED",
				])
				.nullish(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPrReviewEnabled();

		const finding = await setPullRequestReviewFindingStatus({
			id: input.id,
			projectId: input.projectId,
			status: input.status,
			dismissalReason: input.dismissalReason ?? null,
			judgedById: context.user.id,
		});
		if (!finding) {
			throw new ORPCError("NOT_FOUND", {
				message: "That finding was not found.",
			});
		}

		// Audited because DISMISSED is the number a false-positive rate is measured
		// from, and a measurement nobody can attribute is not evidence.
		recordAuditFromRequest(context, {
			action: "project.pull_request.finding_judged",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "pull_request_review_finding", id: finding.id },
			metadata: {
				lens: finding.lens,
				status: input.status,
				dismissalReason: finding.dismissalReason,
			},
		});

		return finding;
	});
