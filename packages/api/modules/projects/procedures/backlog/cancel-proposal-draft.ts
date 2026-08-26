/**
 * Cancel an in-flight in-review draft for a proposal + kind.
 *
 * Used when a reviewer proceeds with creation before the draft finishes, and for
 * the explicit "Cancel" control. Sets the row CANCELLED (compare-and-set on
 * RUNNING) and best-effort cancels the Temporal workflow so the in-flight LLM
 * call is aborted. After cancelling, the slot can be re-claimed ("Draft again").
 */

import { ORPCError } from "@orpc/server";
import { cancelProposalDraft, getPendingBacklogProposal } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const cancelProposalDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/proposals/{proposalId}/draft/cancel",
		tags: ["Projects", "Stories"],
		summary: "Cancel an in-flight in-review draft for a proposal kind",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
			kind: z.enum(["BUG", "FEATURE"]),
		}),
	)
	.handler(async ({ input, context }) => {
		resolveOrganizationId(input.organizationId, context.session);

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
		}

		const cancelled = await cancelProposalDraft({
			proposalId: input.proposalId,
			kind: input.kind,
		});

		// Best-effort: abort the Temporal workflow so the LLM call stops. The DB
		// row is already CANCELLED, so even if this fails the late result is
		// dropped by the activity's compare-and-set.
		if (cancelled?.workflowId) {
			try {
				const client = await getTemporalClient();
				await client.workflow.getHandle(cancelled.workflowId).cancel();
			} catch {
				// Workflow may already be complete/gone — DB state is authoritative.
			}
		}

		return { cancelled: cancelled !== null };
	});
