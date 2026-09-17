import { getProjectInstructionSettings } from "@repo/database";
import { DEFAULT_IGNORE_GLOBS } from "@repo/instructions";
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
 * Reads a project's coding-instructions settings: its ignore-glob override
 * (`null` when the project has never set one), the built-in default globs
 * every upload falls back to absent an override or an uploaded
 * `.fabricignore`, and the resolved source of truth.
 */
export const getSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/settings",
		tags: ["Projects", "Instructions"],
		summary: "Coding-instructions settings",
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
		const s = await getProjectInstructionSettings(
			input.projectId,
			organizationId,
		);
		return {
			ignoreGlobs: s.ignoreGlobs,
			defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
			sourceOfTruth: s.sourceOfTruth,
		};
	});
