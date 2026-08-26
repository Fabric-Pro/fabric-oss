import { ORPCError } from "@orpc/server";
import { getTemplateInstance } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const getInstanceInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(getInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const instance = await getTemplateInstance({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!instance) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}

		return {
			id: instance.id,
			organizationId: instance.organizationId,
			name: instance.name,
			description: instance.description,
			templateId: instance.templateId,
			template: {
				id: instance.template.id,
				name: instance.template.name,
				description: instance.template.description,
				heroEmojis: instance.template.heroEmojis,
				templateType: instance.template.templateType,
				outputFormat: instance.template.outputFormat,
				definition: instance.template.definition,
				parameters: instance.template.parameters,
				connections: instance.template.connections,
				fabricConfig: instance.template.fabricConfig,
			},
			connections: instance.connections,
			parameterDefaults: instance.parameterDefaults,
			fabricConfig: instance.fabricConfig,
			schedule: instance.schedule,
			scheduleMode: instance.scheduleMode,
			isActive: instance.isActive,
			lastRunAt: instance.lastRunAt?.toISOString() || null,
			nextRunAt: instance.nextRunAt?.toISOString() || null,
			createdAt: instance.createdAt.toISOString(),
			updatedAt: instance.updatedAt.toISOString(),
			executionCount: instance._count.executions,
			executions:
				instance.executions?.map((exec: any) => ({
					id: exec.id,
					status: exec.status,
					userId: exec.userId,
					startedAt: exec.startedAt?.toISOString() || null,
					completedAt: exec.completedAt?.toISOString() || null,
					duration: exec.duration,
					error: exec.error,
					mcpDiagnostics: exec.mcpDiagnostics ?? null,
					createdAt: exec.createdAt.toISOString(),
					artifacts:
						exec.artifacts?.map((artifact: any) => ({
							id: artifact.id,
							name: artifact.name,
							artifactType: artifact.artifactType,
							mimeType: artifact.mimeType,
							size: artifact.size,
							createdAt: artifact.createdAt.toISOString(),
						})) || [],
				})) || [],
		};
	});
