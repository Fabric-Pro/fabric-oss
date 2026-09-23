import { ORPCError } from "@orpc/server";
import {
	getAppliedChangeIndexes,
	getPendingBacklogProposal,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Returns the full PendingBacklogProposal record (including the `proposal`
 * JSON) for rendering in the inbox's BacklogChangeProposal UI.
 *
 * The projectId is verified against the stored record to prevent cross-project
 * access via guessed proposal IDs.
 *
 * `createdChangeIndexes` lists the changes this proposal actually applied,
 * from the application table. It differs from the `appliedChangeIndexes`
 * mirror, which also counts a recommended feature skipped because its title
 * was already on the Roadmap.
 */
export const getPendingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals/{proposalId}",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Get a pending backlog proposal",
		description: "Returns the full proposal JSON for review.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const proposal = await getPendingBacklogProposal(input.proposalId);

		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}

		const createdChangeIndexes = Array.from(
			await getAppliedChangeIndexes(proposal.id),
		).sort((a, b) => a - b);

		return { ...proposal, createdChangeIndexes };
	});
