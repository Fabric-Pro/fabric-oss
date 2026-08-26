import { listPendingBacklogProposals } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Returns PendingBacklogProposal rows for the project — surface scoped to the
 * Teams Chat Monitor namespace. Defaults to the "needs-attention" set
 * (PENDING + FAILED) so the inbox surfaces both unreviewed and
 * in-flight items. The underlying query is source-agnostic — the response
 * includes the `source` field so the UI can filter / label per source.
 */
const statusEnum = z.enum([
	"PENDING",
	"APPROVED",
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
		path: "/projects/{projectId}/teams-chat-monitor/pending-proposals",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "List pending backlog proposals (chat-scoped surface)",
		description:
			"Returns backlog proposals awaiting review (default: PENDING + FAILED).",
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
			status: input.status ?? ["PENDING", "FAILED"],
		});
	});
