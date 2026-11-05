import { ORPCError } from "@orpc/server";
import {
	getProjectReportSetupReason,
	getTemplateInstance,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	canDeleteReportInstance,
	canEditProjectReport,
	canEditReportInstance,
	canGenerateReportInstance,
	canManageReportLifecycle,
	canManageReportTemplate,
	isOrganizationReportAdmin,
} from "../../lib/report-access";

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

		const { template } = instance;
		const [
			canGenerate,
			canEdit,
			canDelete,
			canManageLifecycle,
			canSaveToTemplate,
			canSetOrganizationDefault,
			canSetProjectDefault,
		] = await Promise.all([
			canGenerateReportInstance(instance, context.user),
			canEditReportInstance(instance, context.user),
			canDeleteReportInstance(instance, context.user),
			canManageReportLifecycle(instance, context.user),
			// "Update template": whoever may change the template, while it is live
			template.archivedAt
				? false
				: canManageReportTemplate(template, context.user),
			// "Set as organization default": the organization's admins and owners
			instance.organizationId
				? isOrganizationReportAdmin(
						instance.organizationId,
						context.user.id,
					)
				: false,
			// "Set as project default": whoever may edit the project's reports
			instance.organizationId && instance.projectId
				? canEditProjectReport(instance.projectId, context.user)
				: false,
		]);
		// The organization's own templates' prompts are edited on the template,
		// so its default holds only their parameter values.
		const ownedByOrganization =
			template.scope === "ORGANIZATION" &&
			template.organizationId === instance.organizationId;

		return {
			id: instance.id,
			organizationId: instance.organizationId,
			projectId: instance.projectId,
			userId: instance.userId,
			canEdit,
			canDelete,
			canManageLifecycle,
			canGenerate,
			// Saving back follows an edit, so someone who only reads the report
			// is offered none of it, whichever template they also own.
			canSaveToTemplate: canEdit && canSaveToTemplate,
			canSetOrganizationDefault: canEdit && canSetOrganizationDefault,
			canSetOrganizationPrompts:
				canEdit && canSetOrganizationDefault && !ownedByOrganization,
			canSetProjectDefault: canEdit && canSetProjectDefault,
			name: instance.name,
			description: instance.description,
			templateId: instance.templateId,
			template: {
				id: instance.template.id,
				scope: instance.template.scope,
				isPublic: instance.template.isPublic,
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
