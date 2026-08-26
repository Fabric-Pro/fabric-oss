import { listAgentTemplates } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

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

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	scope: z.enum(["SYSTEM", "ORGANIZATION", "USER"]).optional(),
	category: AgentTemplateCategorySchema.optional(),
	tags: z.array(z.string()).optional(),
	search: z.string().optional(),
	isPublished: z.boolean().optional(),
	isFeatured: z.boolean().optional(),
	limit: z.number().min(1).max(100).default(50),
	offset: z.number().min(0).default(0),
	sortBy: z
		.enum(["name", "createdAt", "updatedAt", "useCount", "lastUsedAt"])
		.default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const listTemplatesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if an organizationId is provided
		let verifiedOrgId: string | null = null;
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);
			if (membership) {
				verifiedOrgId = organizationId;
			}
			// If not a member, don't include org templates (silently exclude)
		}

		const { templates, total } = await listAgentTemplates({
			userId: context.user.id,
			organizationId: verifiedOrgId,
			scope: input.scope,
			category: input.category,
			tags: input.tags,
			search: input.search,
			isPublished: input.isPublished,
			isFeatured: input.isFeatured,
			limit: input.limit,
			offset: input.offset,
			sortBy: input.sortBy,
			sortOrder: input.sortOrder,
		});

		return {
			templates,
			total,
			hasMore: input.offset + templates.length < total,
		};
	});
