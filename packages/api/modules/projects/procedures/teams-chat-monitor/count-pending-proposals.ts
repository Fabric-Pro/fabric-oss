import {
	countPendingBacklogProposals,
	REVIEW_INBOX_PROPOSAL_STATUSES,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Lightweight count query for the Roadmap toolbar badge (chat-scoped surface).
 * Counts the shared review-inbox set, including in-flight proposals.
 */
export const countPendingProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-chat-monitor/pending-proposals/count",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Count pending backlog proposals (chat-scoped surface)",
		description:
			"Returns the count of PENDING, APPROVED, APPLYING, and FAILED proposals for the Roadmap badge.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const count = await countPendingBacklogProposals(
			input.projectId,
			REVIEW_INBOX_PROPOSAL_STATUSES,
		);
		return { count };
	});
