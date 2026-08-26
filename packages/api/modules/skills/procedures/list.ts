import { listSkills } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	scope: z.enum(["SYSTEM", "ORGANIZATION", "USER"]).optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	search: z.string().optional(),
	isPublished: z.boolean().optional(),
	limit: z.number().min(1).max(100).default(50),
	offset: z.number().min(0).default(0),
	sortBy: z
		.enum(["name", "createdAt", "updatedAt", "useCount"])
		.default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const listSkillsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.SKILL_READ))
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		let verifiedOrgId: string | null = null;
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			);
			if (membership) {
				verifiedOrgId = organizationId;
			}
		}

		const { skills, total } = await listSkills({
			userId: context.user.id,
			organizationId: verifiedOrgId,
			scope: input.scope,
			category: input.category,
			tags: input.tags,
			search: input.search,
			isPublished: input.isPublished,
			limit: input.limit,
			offset: input.offset,
			sortBy: input.sortBy,
			sortOrder: input.sortOrder,
		});

		return {
			skills,
			total,
			hasMore: input.offset + skills.length < total,
		};
	});
