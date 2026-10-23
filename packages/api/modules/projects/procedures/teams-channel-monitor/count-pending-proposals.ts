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
 * Lightweight count query for the Roadmap toolbar badge. Defaults to counting
 * PENDING, APPROVED, APPLYING, and FAILED rows (the "needs-attention" set).
 */
export const countPendingProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals/count",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Count pending backlog proposals",
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
		// APPLYING is in flight (claimed by an apply workflow) — counted like
		// APPROVED so the badge does not drop while the apply runs.
		const count = await countPendingBacklogProposals(
			input.projectId,
			REVIEW_INBOX_PROPOSAL_STATUSES,
		);
		return { count };
	});
