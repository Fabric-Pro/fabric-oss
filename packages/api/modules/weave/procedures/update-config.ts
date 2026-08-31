/**
 * Update Weave Config Procedure
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess, Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const UpdateConfigInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	config: z.object({
		requireReview: z.boolean().optional(),
		requireSecurityReview: z.boolean().optional(),
		autoExecuteSimple: z.boolean().optional(),
		complexityThreshold: z.enum(["low", "medium", "high"]).optional(),
		enabledSkills: z.array(z.string()).optional(),
		enabledMcpTools: z.array(z.string()).optional(),
		categoryRouting: z.record(z.string(), z.string()).nullable().optional(),
	}),
});

export const updateConfigProcedure = protectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/weave/config/:projectId",
		tags: ["Weave"],
		summary: "Update project weave configuration",
	})
	.input(UpdateConfigInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const normalizedCategoryRouting =
			input.config.categoryRouting === undefined
				? undefined
				: input.config.categoryRouting === null
					? Prisma.JsonNull
					: (input.config.categoryRouting as Prisma.InputJsonValue);

		const createData: Prisma.ProjectWeaveConfigUncheckedCreateInput = {
			projectId: input.projectId,
			userId,
			organizationId: organizationId ?? null,
			...(input.config.requireReview !== undefined
				? { requireReview: input.config.requireReview }
				: {}),
			...(input.config.requireSecurityReview !== undefined
				? { requireSecurityReview: input.config.requireSecurityReview }
				: {}),
			...(input.config.autoExecuteSimple !== undefined
				? { autoExecuteSimple: input.config.autoExecuteSimple }
				: {}),
			...(input.config.complexityThreshold !== undefined
				? { complexityThreshold: input.config.complexityThreshold }
				: {}),
			...(input.config.enabledSkills !== undefined
				? { enabledSkills: input.config.enabledSkills }
				: {}),
			...(input.config.enabledMcpTools !== undefined
				? { enabledMcpTools: input.config.enabledMcpTools }
				: {}),
			...(normalizedCategoryRouting !== undefined
				? { categoryRouting: normalizedCategoryRouting }
				: {}),
		};

		const updateData: Prisma.ProjectWeaveConfigUncheckedUpdateInput = {
			...(input.config.requireReview !== undefined
				? { requireReview: input.config.requireReview }
				: {}),
			...(input.config.requireSecurityReview !== undefined
				? { requireSecurityReview: input.config.requireSecurityReview }
				: {}),
			...(input.config.autoExecuteSimple !== undefined
				? { autoExecuteSimple: input.config.autoExecuteSimple }
				: {}),
			...(input.config.complexityThreshold !== undefined
				? { complexityThreshold: input.config.complexityThreshold }
				: {}),
			...(input.config.enabledSkills !== undefined
				? { enabledSkills: input.config.enabledSkills }
				: {}),
			...(input.config.enabledMcpTools !== undefined
				? { enabledMcpTools: input.config.enabledMcpTools }
				: {}),
			...(normalizedCategoryRouting !== undefined
				? { categoryRouting: normalizedCategoryRouting }
				: {}),
		};

		const config = await db.projectWeaveConfig.upsert({
			where: { projectId: input.projectId },
			create: createData,
			update: updateData,
		});

		return config;
	});
