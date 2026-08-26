import {
	db,
	getActiveInstanceVersion,
	getInstanceVersion,
	getInstanceVersionHistory,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

const getInputSchema = z.object({
	// Can query by id OR by sId
	id: z.string().optional(),
	sId: z.string().optional(),
	// If querying by sId, optionally specify version (default: latest active)
	version: z.number().optional(),
});

export const getInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from Prisma query with select/include — cannot be statically declared
		let instance;

		if (input.id) {
			// Get by id (the database record id)
			instance = await db.agentTemplateInstance.findUnique({
				where: { id: input.id },
				include: {
					template: true,
					integrationConfigurations: {
						where: { isEnabled: true },
						include: {
							integration: {
								select: {
									id: true,
									provider: true,
									name: true,
								},
							},
						},
					},
					memoryFiles: {
						where: { fileType: "SKILL", isEnabled: true },
						select: {
							id: true,
							path: true,
							content: true,
							sourceSkillId: true,
						},
					},
				},
			});
		} else if (input.sId) {
			// Get by sId (stable identifier across versions)
			if (input.version !== undefined) {
				// Get specific version
				instance = await getInstanceVersion(input.sId, input.version);
			} else {
				// Get active version (or latest if no active)
				instance = await getActiveInstanceVersion(input.sId);
			}
		} else {
			throw new Error("Either id or sId must be provided");
		}

		if (!instance) {
			throw new Error("Instance not found");
		}

		// Verify access - check if user owns the instance or is member of the org
		const isOwner = instance.userId === context.user.id;
		let isOrgMember = false;

		if (instance.organizationId) {
			const membership = await verifyOrganizationMembership(
				instance.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error("You don't have access to this instance");
		}

		return { instance };
	});

// Version history endpoint
const versionHistoryInputSchema = z.object({
	sId: z.string(),
	limit: z.number().min(1).max(50).default(10),
	includeArchived: z.boolean().default(true),
});

export const getVersionHistoryProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(versionHistoryInputSchema)
	.handler(async ({ input, context }) => {
		// First, get any version to verify access
		const anyVersion = await db.agentTemplateInstance.findFirst({
			where: { sId: input.sId },
		});

		if (!anyVersion) {
			throw new Error("Instance not found");
		}

		// Verify access
		const isOwner = anyVersion.userId === context.user.id;
		let isOrgMember = false;

		if (anyVersion.organizationId) {
			const membership = await verifyOrganizationMembership(
				anyVersion.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error("You don't have access to this instance");
		}

		const versions = await getInstanceVersionHistory(input.sId, {
			limit: input.limit,
			includeArchived: input.includeArchived,
		});

		return { versions };
	});
