import { listInstructionSnapshots } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { canReviewInstructionProposals } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * Lists every coding-instructions snapshot for a project (newest version
 * first), tenant-scoped by construction: `listInstructionSnapshots` filters
 * on `projectId` AND `organizationId`.
 */
export const listSnapshotsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/snapshots",
		tags: ["Projects", "Instructions"],
		summary: "List coding-instructions snapshots",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const canReviewProposals = await canReviewInstructionProposals({
			projectId: input.projectId,
			userId: context.user.id,
		});
		return listInstructionSnapshots(input.projectId, organizationId, {
			viewerUserId: context.user.id,
			canReviewProposals,
		});
	});
