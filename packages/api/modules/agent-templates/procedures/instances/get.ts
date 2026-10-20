import { ORPCError } from "@orpc/server";
import {
	db,
	getActiveInstanceVersion,
	getInstanceVersion,
	getInstanceVersionHistory,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolvedOrganizationId } from "../../../agents/procedures/conversations/resolved-organization";

const getInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	// Can query by id OR by sId
	id: z.string().optional(),
	sId: z.string().optional(),
	// If querying by sId, optionally specify version (default: latest active)
	version: z.number().optional(),
});

export const getInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_READ, {
			requireOrganization: true,
		}),
	)
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolvedOrganizationId(input, context.session);
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from Prisma query with select/include — cannot be statically declared
		let instance;

		if (input.id) {
			// Get by id (the database record id)
			instance = await db.agentTemplateInstance.findUnique({
				where: { id: input.id },
				include: {
					template: true,
					// Retain disabled-binding declarations without exposing them as enabled scope.
					_count: { select: { mcpServerConfigurations: true } },
					mcpServerConfigurations: {
						where: { isEnabled: true },
						select: { mcpConfigId: true },
					},
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
			throw new ORPCError("BAD_REQUEST", {
				message: "Either id or sId must be provided",
			});
		}

		if (!instance || instance.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Instance not found" });
		}

		return { instance };
	});

// Version history endpoint
const versionHistoryInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	sId: z.string(),
	limit: z.number().min(1).max(50).default(10),
	includeArchived: z.boolean().default(true),
});

export const getVersionHistoryProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_READ, {
			requireOrganization: true,
		}),
	)
	.input(versionHistoryInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolvedOrganizationId(input, context.session);
		// First, get any version to verify access
		const anyVersion = await db.agentTemplateInstance.findFirst({
			where: { sId: input.sId },
		});

		if (!anyVersion || anyVersion.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Instance not found" });
		}

		const versions = await getInstanceVersionHistory(input.sId, {
			limit: input.limit,
			includeArchived: input.includeArchived,
		});

		return { versions };
	});
