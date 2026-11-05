import { ORPCError } from "@orpc/server";
import {
	getProjectReportSetupReason,
	listTemplateInstances,
} from "@repo/database";
import type { TemplateInstanceStatus } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	canReachProjectReports,
	reportGenerationChecker,
} from "../../lib/report-access";
import { reportGenerationBlockedReason } from "../../lib/report-generation-readiness";

const statusEnum = z.enum(["PENDING", "ACTIVE", "ARCHIVED", "DRAFT"]);

const listInstancesInputSchema = z.object({
	templateId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	// List every report of this project instead of only the caller's own.
	projectId: z.string().min(1).max(128).optional(),
	// With a project: only the caller's own reports in it.
	ownedByCaller: z.boolean().default(false),
	limit: z.number().min(1).max(100).default(20),
	offset: z.number().min(0).default(0),
	isActive: z.boolean().optional(),
	status: z.union([statusEnum, z.array(statusEnum)]).optional(),
	search: z.string().optional(),
	latestVersionOnly: z.boolean().default(true),
	// Also return `activeTotal`: the switched-on reports across every page.
	countActive: z.boolean().default(false),
});

export const listInstancesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(listInstancesInputSchema)
	.handler(async ({ input, context }) => {
		// A project's reports are shared with everyone who may read them, so the
		// project is authorized BEFORE the organization resolves to its own.
		if (input.projectId) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.REPORT_READ,
			);
			// Reading the project is not reading its reports: a project guest who
			// is no member of the organization gets nothing, as `get` gives them,
			// and neither does a member who cannot reach the project.
			if (
				!(await canReachProjectReports(input.projectId, context.user))
			) {
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this project's reports",
				});
			}
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await listTemplateInstances({
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			ownedByCaller: input.ownedByCaller,
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
			countActive: input.countActive,
		});

		const mayGenerate = reportGenerationChecker(context.user);
		return {
			instances: await Promise.all(
				result.instances.map(async (instance) => {
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
						projectId: instance.projectId,
						userId: instance.userId,
						canGenerate: await mayGenerate(instance),
						isActive: instance.isActive,
						generateBlockedReason:
							reportGenerationBlockedReason(instance),
						setupRequiredReason: getProjectReportSetupReason(
							instance.fabricConfig,
							instance.template.definition,
							instance.connections,
						),
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
			),
			total: result.total,
			activeTotal: result.activeTotal,
		};
	});
