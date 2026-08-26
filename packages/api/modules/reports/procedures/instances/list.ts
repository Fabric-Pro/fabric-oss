import { listTemplateInstances } from "@repo/database";
import type { TemplateInstanceStatus } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const statusEnum = z.enum(["PENDING", "ACTIVE", "ARCHIVED", "DRAFT"]);

const listInstancesInputSchema = z.object({
	templateId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(100).default(20),
	offset: z.number().min(0).default(0),
	isActive: z.boolean().optional(),
	status: z.union([statusEnum, z.array(statusEnum)]).optional(),
	search: z.string().optional(),
	latestVersionOnly: z.boolean().default(true),
});

export const listInstancesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(listInstancesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await listTemplateInstances({
			userId: context.user.id,
			organizationId,
			templateId: input.templateId,
			limit: input.limit,
			offset: input.offset,
			isActive: input.isActive,
			status: input.status as
				| TemplateInstanceStatus
				| TemplateInstanceStatus[]
				| undefined,
			search: input.search,
			latestVersionOnly: input.latestVersionOnly,
		});

		return {
			instances: result.instances.map((instance) => {
				const latestExec = instance.executions?.[0];
				return {
					id: instance.id,
					sId: instance.sId,
					version: instance.version,
					status: instance.status,
					name: instance.name,
					description: instance.description,
					templateId: instance.templateId,
					templateName: instance.template.name,
					isActive: instance.isActive,
					schedule: instance.schedule,
					scheduleMode: instance.scheduleMode,
					lastRunAt: instance.lastRunAt?.toISOString() || null,
					nextRunAt: instance.nextRunAt?.toISOString() || null,
					executionCount: instance._count.executions,
					latestExecutionStatus: latestExec?.status || null,
					latestExecutionStartedAt:
						latestExec?.startedAt?.toISOString() || null,
					createdAt: instance.createdAt.toISOString(),
					updatedAt: instance.updatedAt.toISOString(),
				};
			}),
			total: result.total,
		};
	});
