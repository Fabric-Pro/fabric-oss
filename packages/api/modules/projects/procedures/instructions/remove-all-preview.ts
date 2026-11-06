/**
 * removeAllPreview — what "Remove coding instructions" would do now, for its
 * confirmation: how many versions it deletes, the version that is published,
 * and the refusal it would meet (`blockedBy`, the `data.reason` a refused
 * `removeAll` carries), null when nothing stands in the way.
 *
 * The count is every snapshot of the project. History (`instructions.list`)
 * cannot give it: it hides other members' proposals from a viewer who does
 * not review them, and every git intent row, all of which the removal
 * deletes. For the same reason `blockedBy` is read here, not from History: a
 * proposal waiting for review that the viewer cannot see still blocks.
 *
 * Advice only, read without locks; `removeAll` decides again under its locks.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_DELETE), the permission of the removal
 * it describes: it counts rows History hides from readers. The organization
 * is the project's hosting one (`requireHostingOrganizationId`).
 */
import { ORPCError } from "@orpc/client";
import { previewRemoveAllProjectInstructions } from "@repo/database";
import { z } from "zod";
import {
	PROJECT_NOT_FOUND_MESSAGE,
	projectNotFoundUnlessVisible,
} from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { REMOVAL_CONFLICT_REASON } from "./remove-all-reasons";

export const removeAllInstructionsPreviewProcedure = tenantProtectedProcedure
	// Visibility before permission, as on every sibling.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_DELETE))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/remove-all/preview",
		tags: ["Projects", "Instructions"],
		summary: "Preview removing the project's coding instructions",
		description:
			"Answers `{ snapshotCount, publishedVersion, blockedBy }`: how many coding-instructions versions removing them would delete, the published version (null when none is), and the CONFLICT reason the removal would meet now (null when none). Changes nothing.",
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
		const preview = await previewRemoveAllProjectInstructions(
			input.projectId,
			organizationId,
		);
		if (preview === null) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}
		return {
			snapshotCount: preview.snapshotCount,
			publishedVersion: preview.publishedVersion,
			blockedBy:
				preview.blockedBy === null
					? null
					: REMOVAL_CONFLICT_REASON[preview.blockedBy],
		};
	});
