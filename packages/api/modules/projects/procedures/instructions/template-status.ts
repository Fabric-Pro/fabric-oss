import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { readOrganizationTemplate } from "./organization-template";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Whether this project's organization offers a template for coding
 * instructions that the project could start from, for the Coding Instructions
 * tab to decide whether to offer it. Answers about the template's published
 * version only — its number and how many files it holds — and never names the
 * template project: the caller is not required to have access to it.
 */
export const templateStatusProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/template-status",
		tags: ["Projects", "Instructions"],
		summary:
			"Whether the organization template for coding instructions is available",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const template = await readOrganizationTemplate({
			organizationId,
			projectId: input.projectId,
		});
		return {
			available: template.state === "available",
			isTemplateProject: template.state === "is_template",
			version:
				template.state === "available"
					? template.snapshot.version
					: null,
			fileCount:
				template.state === "available"
					? template.snapshot.fileCount
					: null,
		};
	});
