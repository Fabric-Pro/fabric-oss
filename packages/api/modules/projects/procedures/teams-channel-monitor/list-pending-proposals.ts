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
 * Returns PendingBacklogProposal rows for the project. Defaults to the
 * review-inbox set (PENDING, APPROVED, APPLYING, FAILED); pass an explicit
 * status list to override.
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
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals",
		tags: ["Projects", "Teams Channel Monitor"],
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
