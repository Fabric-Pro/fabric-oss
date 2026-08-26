/**
 * Start (or reuse) the server-persisted, team-shared in-review draft for a
 * pending proposal + kind.
 *
 * Race-safe: `claimProposalDraft` atomically claims the `(proposalId, kind)`
 * slot, so concurrent opens from many users/tabs start exactly ONE draft. Only
 * the caller that wins the claim starts the Temporal workflow; everyone else
 * gets the in-flight/finished row back. Idempotent — safe to call on every open
 * and on every Bug/Feature toggle.
 */

import { ORPCError } from "@orpc/server";
import {
	claimProposalDraft,
	failProposalDraft,
	getPendingBacklogProposal,
	setProposalDraftWorkflowId,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Pull the draftable change (the create) out of the stored proposal JSON. */
function extractDraftableChange(proposalJson: unknown): {
	title: string;
	description?: string;
	acceptanceCriteria?: string;
} | null {
	const changes =
		proposalJson &&
		typeof proposalJson === "object" &&
		"changes" in proposalJson &&
		Array.isArray((proposalJson as { changes: unknown }).changes)
			? (proposalJson as { changes: Array<Record<string, any>> }).changes
			: [];
	const change =
		changes.find((c) => c?.action === "create") ?? changes[0] ?? null;
	if (!change) {
		return null;
	}
	return {
		title: change.title?.to ?? "",
		description: change.description?.to ?? undefined,
		acceptanceCriteria: change.acceptanceCriteria?.to ?? undefined,
	};
}

export const startProposalDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/proposals/{proposalId}/draft/start",
		tags: ["Projects", "Stories"],
		summary:
			"Start or reuse the persisted in-review draft for a proposal kind",
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
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
		}

		const draftable = extractDraftableChange(proposal.proposal);
		if (!draftable) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Proposal has no draftable change",
			});
		}

		const { draft, claimed } = await claimProposalDraft({
			proposalId: input.proposalId,
			kind: input.kind,
			createdBy: user.id,
		});

		// Only the winner of the claim starts the workflow — everyone else just
		// observes the shared row (no duplicate draft, no double spend).
		if (claimed) {
			try {
				const client = await getTemporalClient();
				const workflowId = `proposal-draft-${input.proposalId}-${input.kind}-${Date.now()}`;
				await client.workflow.start(
					"draftProposalBodyWorkflow",
					withCorrelationMemo({
						taskQueue: "ai-chat",
						workflowId,
						args: [
							{
								proposalId: input.proposalId,
								kind: input.kind,
								projectId: input.projectId,
								organizationId: organizationId ?? undefined,
								userId: user.id,
								title: draftable.title,
								description: draftable.description,
								acceptanceCriteria:
									draftable.acceptanceCriteria,
							},
						],
					}),
				);
				await setProposalDraftWorkflowId({
					proposalId: input.proposalId,
					kind: input.kind,
					workflowId,
				});
			} catch (err) {
				// Couldn't dispatch — mark FAILED so the UI offers "Draft again"
				// rather than spinning on a RUNNING row that will never resolve.
				await failProposalDraft({
					proposalId: input.proposalId,
					kind: input.kind,
					error:
						err instanceof Error
							? err.message
							: "Failed to start draft workflow",
				});
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to start draft",
				});
			}
		}

		return {
			proposalId: draft.proposalId,
			kind: draft.kind,
			status: draft.status,
			startedAt: draft.startedAt,
			completedAt: draft.completedAt,
			description: draft.description,
			acceptanceCriteria: draft.acceptanceCriteria,
			needsMoreInfo: draft.needsMoreInfo,
		};
	});
