import { createAgentTemplate, getAgentTemplateBySlug } from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../../orpc/procedures";

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

const createInputSchema = z.object({
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z0-9-]+$/),
	name: z.string().min(1).max(100),
	displayName: z.string().min(1).max(200),
	description: z.string().min(1),
	instructions: z.string().min(1),
	heroEmojis: z.array(z.string()).optional(),
	heroImageUrl: z.string().url().optional(),
	category: AgentTemplateCategorySchema.default("GENERAL"),
	tags: z.array(z.string()).optional(),
	suggestedModel: z.string().optional(),
	modelConfig: z.any().optional(),
	promptBindingId: z.string().optional(),
	documentType: z.string().optional(),
	isPublished: z.boolean().default(false),
});

export const createTemplateProcedure = adminProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(createInputSchema)
	.handler(async ({ input, context }) => {
		// Check if slug already exists
		const existing = await getAgentTemplateBySlug(input.slug);
		if (existing) {
			throw new Error("A template with this slug already exists");
		}

		const template = await createAgentTemplate({
			slug: input.slug,
			name: input.name,
			displayName: input.displayName,
			description: input.description,
			instructions: input.instructions,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl,
			category: input.category,
			tags: input.tags,
			suggestedModel: input.suggestedModel,
			modelConfig: input.modelConfig as Prisma.InputJsonValue | undefined,
			promptBindingId: input.promptBindingId,
			documentType: input.documentType,
			scope: "SYSTEM",
			userId: context.user.id,
			isPublished: input.isPublished,
		});

		return { template };
	});
