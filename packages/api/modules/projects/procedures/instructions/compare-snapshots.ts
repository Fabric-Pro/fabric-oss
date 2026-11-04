import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { compareInstructionVersions } from "./compare-core";
import { requireHostingOrganizationId } from "./hosting-organization";
import { isInstructionSnapshotContentReadable } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * What changed between two of a project's coding-instruction versions, as a
 * PATH manifest only — no bytes are read and no storage location is served.
 * Bodies stay behind `getFile`, which the client calls per expanded row, so
 * this route costs two file-list queries however large the versions are.
 *
 * Both snapshots are loaded through the tenant-scoped
 * `getInstructionSnapshot(id, projectId, organizationId)` (R11), and both must
 * pass the same content gate `get-file.ts` applies before serving a body:
 * READY, and either a direct version or an APPROVED proposal. A pending or
 * rejected proposal 404s exactly like a missing snapshot — otherwise a viewer
 * who cannot read a proposal's files could still enumerate the paths it adds,
 * renames or deletes through this route.
 *
 * `sha256` and `storageKey` are read to compute the diff and are stripped from
 * the response, for the reason spelled out on `list-files.ts`.
 */
export const compareSnapshotsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/compare",
		tags: ["Projects", "Instructions"],
		summary: "Compare two instruction snapshots",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			fromSnapshotId: z.string(),
			toSnapshotId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const [from, to] = await Promise.all([
			getInstructionSnapshot(
				input.fromSnapshotId,
				input.projectId,
				organizationId,
			),
			getInstructionSnapshot(
				input.toSnapshotId,
				input.projectId,
				organizationId,
			),
		]);
		// Fail closed on either side, and with the same message either way:
		// which of the two ids was unreadable is itself an answer about a
		// snapshot the caller may not read.
		if (
			!from ||
			!to ||
			!isInstructionSnapshotContentReadable(from) ||
			!isInstructionSnapshotContentReadable(to)
		) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}

		return {
			from: { id: from.id, version: from.version },
			to: { id: to.id, version: to.version },
			...(await compareInstructionVersions({
				fromSnapshotId: from.id,
				toSnapshotId: to.id,
				organizationId,
			})),
		};
	});
