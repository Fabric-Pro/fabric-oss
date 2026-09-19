import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot, listInstructionFiles } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { buildInstructionSnapshotZip } from "./build-zip";
import { requireHostingOrganizationId } from "./hosting-organization";
import { isInstructionSnapshotContentReadable } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * Zips the approved (READY) file set of one snapshot from its immutable
 * `snapshots/` prefix — never the original `staging/` upload — and returns a
 * short-lived signed GET URL. Tenant-scoped via `getInstructionSnapshot(id,
 * projectId, organizationId)` first (R11); only a READY snapshot can be
 * downloaded. The archive itself is built by `buildInstructionSnapshotZip`,
 * shared with the MCP `fabric_get_project_instruction_bundle` tool so both
 * surfaces produce the same export.
 */
export const createDownloadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/download",
		tags: ["Projects", "Instructions"],
		summary: "Zip the approved snapshot and return a short-lived link",
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
		if (!snapshot || !isInstructionSnapshotContentReadable(snapshot)) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		const files = await listInstructionFiles(snapshot.id, organizationId);
		const { url } = await buildInstructionSnapshotZip({
			projectId: input.projectId,
			organizationId,
			snapshot,
			files,
		});
		return { url, fileCount: files.length };
	});
