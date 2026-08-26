/**
 * Poll the persisted in-review drafts for a proposal (both kinds).
 *
 * The inbox polls this for the shared "drafting" counter (derived from the
 * server `startedAt`, so every tab/user shows the same elapsed time) and to swap
 * in the finished body once a draft completes.
 */

import { ORPCError } from "@orpc/server";
import { getPendingBacklogProposal, getProposalDrafts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getProposalDraftsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/proposals/{proposalId}/draft/list",
		tags: ["Projects", "Stories"],
		summary:
			"Get the persisted in-review drafts for a proposal (both kinds)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Resolve org for tenant consistency even though the read is by proposalId.
		resolveOrganizationId(input.organizationId, context.session);

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
		}

		const drafts = await getProposalDrafts(input.proposalId);
		return {
			drafts: drafts.map((d) => ({
				kind: d.kind,
				status: d.status,
				startedAt: d.startedAt,
				completedAt: d.completedAt,
				description: d.description,
				acceptanceCriteria: d.acceptanceCriteria,
				needsMoreInfo: d.needsMoreInfo,
			})),
		};
	});
