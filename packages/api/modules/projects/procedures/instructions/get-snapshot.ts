import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * Reads one coding-instructions snapshot by id, tenant-scoped via
 * `getInstructionSnapshot(id, projectId, organizationId)` (R11).
 */
export const getSnapshotProcedure = tenantProtectedProcedure
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
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		return snapshot;
	});
