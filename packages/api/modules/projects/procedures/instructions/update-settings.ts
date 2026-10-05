import { updateProjectInstructionSettings } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { projectIgnoreGlobsSchema } from "./ignore-globs-input";
import { assertNoOpenMigration, withMigrationFreeze } from "./migration-freeze";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_UPDATE).
 *
 * Updates the project's coding-instructions ignore-glob override.
 * `ignoreGlobs: null` clears the override so future uploads fall back to
 * `DEFAULT_IGNORE_GLOBS` (or an uploaded `.fabricignore`, which always
 * outranks both).
 */
export const updateSettingsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/instructions/settings",
		tags: ["Projects", "Instructions"],
		summary: "Update coding-instructions settings",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			ignoreGlobs: projectIgnoreGlobsSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		// New ignore rules would re-plan what a move into the repository
		// carries and fence its sync row (Fizzy #2878 §9).
		await assertNoOpenMigration({
			projectId: input.projectId,
			organizationId,
		});
		await withMigrationFreeze(
			{ projectId: input.projectId, organizationId },
			() =>
				updateProjectInstructionSettings(
					input.projectId,
					organizationId,
					{
						ignoreGlobs: input.ignoreGlobs,
					},
				),
		);
		recordAuditFromRequest(context, {
			action: "project.instructions.settings_updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: { ignoreGlobCount: input.ignoreGlobs?.length ?? 0 },
		});
		return { ok: true };
	});
