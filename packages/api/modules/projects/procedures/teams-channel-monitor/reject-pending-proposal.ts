import { ORPCError } from "@orpc/server";
import {
	getPendingBacklogProposal,
	markPendingProposalRejected,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * dismiss proposals.
 *
 * Terminal dismissal — flips the proposal to REJECTED. The associated
 * seen-message markers remain, so the thread will not be re-analyzed.
 */
export const rejectPendingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals/{proposalId}/reject",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Reject a pending backlog proposal",
		description: "Marks a proposal as REJECTED (dismissed).",
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

		const { updated } = await markPendingProposalRejected({
			proposalId: input.proposalId,
			reviewedBy: user.id,
		});
		if (!updated) {
			// Another reviewer already approved/rejected it (or it is terminal):
			// surface a conflict so the inbox shows the "already actioned" toast
			// instead of silently overwriting their decision.
			throw new ORPCError("CONFLICT", {
				message:
					"This proposal has already been approved or rejected perhaps by another user.",
			});
		}

		return { success: true };
	});
