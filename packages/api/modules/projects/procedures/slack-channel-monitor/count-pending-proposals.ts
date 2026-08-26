import { countPendingBacklogProposals } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Source-agnostic count of PendingBacklogProposal rows for the project. The
 * underlying query already merges Teams + Slack + future sources — this
 * procedure is scoped to the Slack route surface but does NOT filter by
 * source so the Roadmap badge remains consistent across providers.
 */
export const countPendingProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/slack-channel-monitor/pending-proposals/count",
		tags: ["Projects", "Slack Channel Monitor"],
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
