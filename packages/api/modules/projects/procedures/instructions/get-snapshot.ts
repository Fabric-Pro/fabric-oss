import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { canReviewInstructionProposals } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Reads one coding-instructions snapshot by id, tenant-scoped via
 * `getInstructionSnapshot(id, projectId, organizationId)` (R11), with the
 * visibility `listSnapshots` applies: a pending or rejected proposal is seen
 * only by its proposer or a reviewer, and is NOT_FOUND for anyone else.
 */
export const getSnapshotProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId",
		tags: ["Projects", "Instructions"],
		summary: "Get one coding-instructions snapshot",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
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
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
			{ viewerUserId: context.user.id, canReviewProposals },
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		return snapshot;
	});
