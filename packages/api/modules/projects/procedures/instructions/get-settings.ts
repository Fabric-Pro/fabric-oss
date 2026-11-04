import { getProjectInstructionSettings } from "@repo/database";
import { DEFAULT_IGNORE_GLOBS } from "@repo/instructions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Reads a project's coding-instructions settings: its ignore-glob override
 * (`null` when the project has never set one), the built-in default globs
 * every upload falls back to absent an override or an uploaded
 * `.fabricignore`, the resolved source of truth, and the upload-mode
 * proposal review policy.
 */
export const getSettingsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
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
			// Upload-mode proposal review policy; `{ requiredApprovals: 1,
			// approverUserIds: null }` when the project never set one.
			reviewPolicy: s.reviewPolicy,
		};
	});
