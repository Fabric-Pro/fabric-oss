import { getFrameTemplateCategories, listFrameTemplates } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	category: z.string().optional(),
	includeSystem: z.boolean().default(true),
});

const outputSchema = z.object({
	templates: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			description: z.string().nullable(),
			category: z.string(),
			variables: z.record(z.string(), z.any()).nullable(),
			isSystem: z.boolean(),
			createdAt: z.string(),
		}),
	),
	categories: z.array(z.string()),
});

export const listFrameTemplatesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frame-templates",
		tags: ["Frame Templates"],
		summary: "List frame templates",
		description:
			"Get all available frame templates (system + org-specific)",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const [templates, categories] = await Promise.all([
			listFrameTemplates({
				organizationId,
				category: input.category,
				includeSystem: input.includeSystem,
			}),
			getFrameTemplateCategories(organizationId),
		]);

		return {
			templates: templates.map((t) => ({
				id: t.id,
				name: t.name,
				description: t.description ?? null,
				category: t.category,
				variables: t.variables ?? null,
				isSystem: t.isSystem,
				createdAt: t.createdAt.toISOString(),
			})),
			categories,
		};
	});
