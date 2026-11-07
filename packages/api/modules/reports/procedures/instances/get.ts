import { ORPCError } from "@orpc/server";
import {
	getProjectReportSetupReason,
	getTemplateInstance,
} from "@repo/database";
import { projectReportDiagnostics } from "@repo/database/prisma/queries/lib/report-public-diagnostics";
import { loadReportDiagnosticSources } from "@repo/database/prisma/queries/report-diagnostic-labels";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import type { ReportCommandContext } from "../../lib/report-command-context";

export const getInstanceInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(getInstanceInputSchema)
	.handler(handleGetReportInstance);

export async function handleGetReportInstance({
	input,
	context,
}: {
	input: z.infer<typeof getInstanceInputSchema>;
	context: ReportCommandContext;
}) {
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

	const diagnosticSources = await loadReportDiagnosticSources(
		{ userId: context.user.id, organizationId },
		instance,
	);

	return {
		id: instance.id,
		version: instance.version,
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
		setupRequiredReason: getProjectReportSetupReason(
			instance.fabricConfig,
			instance.template.definition,
			instance.connections,
		),
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
				error: exec.error
					? "The report did not finish. Review its run details before trying again."
					: null,
				mcpDiagnostics: projectReportDiagnostics(
					exec.mcpDiagnostics,
					diagnosticSources,
				),
				createdAt: exec.createdAt.toISOString(),
				artifacts:
					exec.artifacts?.map((artifact: any) => ({
						id: artifact.id,
						linkedFrameId:
							artifact.metadata &&
							typeof artifact.metadata === "object" &&
							typeof artifact.metadata.linkedFrameId ===
								"string" &&
							/^[a-zA-Z0-9_-]{1,128}$/.test(
								artifact.metadata.linkedFrameId,
							)
								? artifact.metadata.linkedFrameId
								: null,
						name: artifact.name,
						artifactType: artifact.artifactType,
						mimeType: artifact.mimeType,
						size: artifact.size,
						createdAt: artifact.createdAt.toISOString(),
					})) || [],
			})) || [],
	};
}
