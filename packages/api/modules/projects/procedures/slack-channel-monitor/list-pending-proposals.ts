import {
	listPendingBacklogProposals,
	REVIEW_INBOX_PROPOSAL_STATUSES,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Source-agnostic list of PendingBacklogProposal rows for the project,
 * defaulting to the review-inbox set (PENDING, APPROVED, APPLYING, FAILED).
 * The underlying query is shared with the Teams routes — the per-source route
 * surface exists for UX namespacing, not for filtering by `source`.
 */
const statusEnum = z.enum([
	"PENDING",
	"APPROVED",
	"APPLYING",
	"APPLIED",
	"REJECTED",
	"FAILED",
	"SUPERSEDED",
	"BACKLOG",
]);

export const listPendingProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/slack-channel-monitor/pending-proposals",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "List pending backlog proposals",
		description:
			"Returns backlog proposals awaiting review (default: PENDING, APPROVED, APPLYING, and FAILED).",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z.array(statusEnum).optional(),
		}),
	)
	.handler(async ({ input }) => {
		return await listPendingBacklogProposals({
			projectId: input.projectId,
			status: input.status ?? REVIEW_INBOX_PROPOSAL_STATUSES,
		});
	});
