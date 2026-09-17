import { ORPCError } from "@orpc/client";
import { getPublishedInstructionSnapshot } from "@repo/database";
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
 * Reads the project's currently published coding-instructions snapshot.
 * `getPublishedInstructionSnapshot(projectId)` is UNSCOPED by design (the
 * published pointer lives on the `Project` row, keyed only by its id), so
 * this handler verifies the returned row's `organizationId` matches the
 * project's hosting organization before returning it (R11) — a mismatch
 * 404s exactly like "nothing published" rather than leaking cross-tenant
 * existence.
 */
export const getPublishedSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/published",
		tags: ["Projects", "Instructions"],
		summary: "Get the published coding-instructions snapshot",
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
		const snapshot = await getPublishedInstructionSnapshot(input.projectId);
		if (!snapshot || snapshot.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", {
				message: "No published snapshot",
			});
		}
		return snapshot;
	});
