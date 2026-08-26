import { countPendingBacklogProposals } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Lightweight count query for the Roadmap toolbar badge. Defaults to counting
 * PENDING + FAILED rows (the "needs-attention" set).
 */
export const countPendingProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals/count",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Count pending backlog proposals",
		description:
			"Returns the count of PENDING + FAILED proposals for the Roadmap badge.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const count = await countPendingBacklogProposals(input.projectId, [
			"PENDING",
			"FAILED",
		]);
		return { count };
	});
