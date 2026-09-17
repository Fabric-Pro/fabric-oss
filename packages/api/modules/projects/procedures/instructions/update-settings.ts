import { updateProjectInstructionSettings } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_UPDATE).
 *
 * Updates the project's coding-instructions ignore-glob override.
 * `ignoreGlobs: null` clears the override so future uploads fall back to
 * `DEFAULT_IGNORE_GLOBS` (or an uploaded `.fabricignore`, which always
 * outranks both).
 */
export const updateSettingsProcedure = tenantProtectedProcedure
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
			ignoreGlobs: z
				.array(z.string().min(1).max(256))
				.max(200)
				.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		await updateProjectInstructionSettings(
			input.projectId,
			organizationId,
			{
				ignoreGlobs: input.ignoreGlobs,
			},
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
