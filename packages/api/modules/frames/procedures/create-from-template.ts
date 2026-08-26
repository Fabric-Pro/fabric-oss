import {
	createFrame,
	getFrameTemplateById,
	substituteTemplateVariables,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	templateId: z.string(),
	variables: z.record(z.string(), z.string()).default({}),
	title: z.string().optional(),
	description: z.string().optional(),
});

const outputSchema = z.object({
	success: z.boolean(),
	frame: z
		.object({
			id: z.string(),
			title: z.string(),
			path: z.string(),
		})
		.optional(),
	error: z.string().optional(),
});

export const createFrameFromTemplateProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/frames/from-template",
		tags: ["Frame Templates"],
		summary: "Create frame from template",
		description:
			"Create a new frame using a template with variable substitution",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		try {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// Get the template
			const template = await getFrameTemplateById(input.templateId);

			if (!template) {
				return {
					success: false,
					error: "Template not found",
				};
			}

			// Check access (system templates are public, org templates need membership)
			if (
				!template.isSystem &&
				template.organizationId !== organizationId
			) {
				return {
					success: false,
					error: "You don't have access to this template",
				};
			}

			// Substitute variables
			let content = template.content;
			if (template.variables) {
				content = substituteTemplateVariables(
					template.content,
					template.variables,
					input.variables,
				);
			}

			// Override title/description if provided
			const finalTitle = input.title || content.title;
			const finalDescription = input.description || content.description;

			// Create the frame
			const frame = await createFrame({
				userId: context.user.id,
				organizationId,
				title: finalTitle,
				description: finalDescription,
				kind: content.kind,
				blocks: content.blocks,
				theme: content.theme,
			});

			return {
				success: true,
				frame: {
					id: frame.id,
					title: frame.title,
					path: frame.path,
				},
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
