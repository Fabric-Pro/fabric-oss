import { listReportTemplates } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	scope: z.enum(["SYSTEM", "ORGANIZATION", "USER"]).optional(),
	templateType: z
		.enum([
			"GANTT_CHART",
			"BURNDOWN",
			"SPRINT_COMPLETION",
			"FEATURE_SUMMARY",
			"MONTHLY_REPORT",
			"QUARTERLY_REPORT",
			"INTEGRATION_ACTIVITY",
			"CUSTOM",
		])
		.optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	search: z.string().optional(),
	isPublic: z.boolean().optional(),
	limit: z.number().min(1).max(100).default(50),
	offset: z.number().min(0).default(0),
	sortBy: z
		.enum(["name", "createdAt", "updatedAt", "useCount", "lastUsedAt"])
		.default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const listTemplatesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { templates, total } = await listReportTemplates({
			userId: context.user.id,
			organizationId,
			scope: input.scope,
			templateType: input.templateType,
			category: input.category,
			tags: input.tags,
			search: input.search,
			isPublic: input.isPublic,
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
