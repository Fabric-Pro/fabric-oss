import { ORPCError } from "@orpc/server";
import {
	getPendingBacklogProposal,
	markPendingProposalBacklog,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can defer
 * proposals (same permission as approve/reject).
 *
 * Deferral, NOT dismissal — flips a PENDING proposal to BACKLOG. The proposal
 * is preserved and stays retrievable (inbox Backlog section / roadmap pill),
 * but is excluded from the active review queue and every needs-attention count
 * / context path exactly like REJECTED. Reversible — it can later be approved
 * or rejected. The associated seen-message markers remain, so the same Slack
 * thread won't be re-analyzed on a future backfill or live signal.
 */
export const backlogPendingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/pending-proposals/{proposalId}/backlog",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Move a pending backlog proposal to Backlog",
		description:
			"Defers a PENDING proposal to BACKLOG — hidden from the active review queue but retrievable and reversible.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// resolveOrganizationId is called to validate session context even
		// though the DB call doesn't need the value directly.
		resolveOrganizationId(input.organizationId, context.session);

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}

		const { updated } = await markPendingProposalBacklog({
			proposalId: input.proposalId,
			reviewedBy: user.id,
		});
		if (!updated) {
			// Only a PENDING proposal can be deferred; anything else (already
			// approved / rejected / applied / backlogged, e.g. by another
			// reviewer) matches 0 rows. Surface a conflict rather than a silent
			// no-op so the inbox can refresh to the current state.
			throw new ORPCError("CONFLICT", {
				message:
					"This proposal can no longer be moved to Backlog — it may have already been actioned.",
			});
		}

		return { success: true };
	});
