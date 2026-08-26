import { getAgentTemplate, updateAgentTemplate } from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const AgentTemplateCategorySchema = z.enum([
	"DATA",
	"DESIGN",
	"ENGINEERING",
	"FINANCE",
	"HIRING",
	"KNOWLEDGE",
	"LEGAL",
	"MARKETING",
	"OPERATIONS",
	"PRODUCT",
	"PRODUCT_MANAGEMENT",
	"PRODUCTIVITY",
	"SALES",
	"SUPPORT",
	"GENERAL",
]);

const updateInputSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(100).optional(),
	displayName: z.string().min(1).max(200).optional(),
	description: z.string().min(1).optional(),
	instructions: z.string().min(1).optional(),
	heroEmojis: z.array(z.string()).optional(),
	heroImageUrl: z.string().url().nullable().optional(),
	category: AgentTemplateCategorySchema.optional(),
	tags: z.array(z.string()).optional(),
	suggestedModel: z.string().optional(),
	modelConfig: z.any().optional(),
	isPublished: z.boolean().optional(),
});

export const updateTemplateProcedure = adminProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(updateInputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership
		const existing = await getAgentTemplate(input.id);
		if (!existing) {
			throw new Error("Template not found");
		}

		// System templates are admin-managed and may be updated here.
		if (existing.scope === "SYSTEM") {
			const template = await updateAgentTemplate({
				id: input.id,
				name: input.name,
				displayName: input.displayName,
				description: input.description,
				instructions: input.instructions,
				heroEmojis: input.heroEmojis,
				heroImageUrl: input.heroImageUrl ?? undefined,
				category: input.category,
				tags: input.tags,
				suggestedModel: input.suggestedModel,
				modelConfig: input.modelConfig as
					| Prisma.InputJsonValue
					| undefined,
				isPublished: input.isPublished,
			});

			return { template };
		}

		// Check permissions based on scope
		if (existing.scope === "USER") {
			// User templates can only be updated by the owner
			if (existing.userId !== context.user.id) {
				throw new Error(
					"You don't have permission to update this template",
				);
			}
		} else if (existing.scope === "ORGANIZATION") {
			// Organization templates require org admin/owner membership
			if (!existing.organizationId) {
				throw new Error(
					"Organization template is missing organizationId",
				);
			}
			const membership = await requireOrgMembership(
				context.user.id,
				existing.organizationId,
				["owner", "admin"],
			);
			if (!membership) {
				throw new Error(
					"You must be an organization owner or admin to update organization templates",
				);
			}
		}

		const template = await updateAgentTemplate({
			id: input.id,
			name: input.name,
			displayName: input.displayName,
			description: input.description,
			instructions: input.instructions,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl ?? undefined,
			category: input.category,
			tags: input.tags,
			suggestedModel: input.suggestedModel,
			modelConfig: input.modelConfig as Prisma.InputJsonValue | undefined,
			isPublished: input.isPublished,
		});

		return { template };
	});
