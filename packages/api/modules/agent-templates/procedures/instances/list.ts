import type { AgentInstanceStatus } from "@repo/database";
import { listAgentTemplateInstances } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

const agentInstanceStatusSchema = z.enum([
	"DRAFT",
	"PENDING",
	"ACTIVE",
	"ARCHIVED",
]);

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	templateId: z.string().optional(),
	// New versioning-aware status filter
	status: z
		.union([agentInstanceStatusSchema, z.array(agentInstanceStatusSchema)])
		.optional(),
	/** @deprecated Use status instead */
	isActive: z.boolean().optional(),
	search: z.string().optional(),
	limit: z.number().min(1).max(100).default(50),
	offset: z.number().min(0).default(0),
	sortBy: z
		.enum(["name", "createdAt", "updatedAt", "runCount", "lastRunAt"])
		.default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
	// If true, only return the latest version of each instance (by sId)
	latestVersionOnly: z.boolean().default(true),
});

export const listInstancesProcedure = tenantProtectedProcedure
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
			// If not a member, don't include org instances (silently exclude)
		}

		const { instances, total } = await listAgentTemplateInstances({
			userId: context.user.id,
			organizationId: verifiedOrgId,
			templateId: input.templateId,
			status: input.status as AgentInstanceStatus | AgentInstanceStatus[],
			isActive: input.isActive,
			search: input.search,
			limit: input.limit,
			offset: input.offset,
			sortBy: input.sortBy,
			sortOrder: input.sortOrder,
			latestVersionOnly: input.latestVersionOnly,
		});

		return {
			instances,
			total,
			hasMore: input.offset + instances.length < total,
		};
	});
